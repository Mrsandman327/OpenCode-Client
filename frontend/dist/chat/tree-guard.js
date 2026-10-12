// ============================================================
// chat-tree-guard.js — 项目树重建的并发合并 + 「本地已删会话」去重
// ============================================================
// 纯逻辑，不碰 DOM、不 import 浏览器依赖，因此可在 Node 下直接单测
// （chat/tree.js import 了 apicall.js / mobile.js / events.js，测试进程
//  根本加载不了它）。
//
// 存在的原因：删除会话时「树一直闪」。两个根因：
//
//   根因一  buildTree() 原本没有任何并发保护。每调用一次就重新拉全量树，
//           再 container.innerHTML 把整棵树拆了重建。删一个会话会引发多条
//           session.deleted（会话自身 + 其子会话各一条），每条都触发一次
//           全量重建 = 连续闪烁 N 次。而且这些调用是 async 的，慢的那轮
//           可能后到，把先到的渲染结果覆盖回去（树会「倒退」一下）。
//
//   根因二  原本用单个布尔 window._skipSessionDeletedRebuild 表示
//           「这次删除别重建」。但一条 DELETE 会发出多条事件，布尔只被
//           **第一条**消费掉，剩下的每条都落到重建分支；而且布尔分不清是
//           哪个会话——2 秒窗口内别的会话被删也会被吞掉，那条会话就会
//           永远留在树里（删了却还在）。
//
// 对应两个原语：
//   createBuildGate       合并并发重建请求，并让所有调用方等同一个结果
//   createRecentlyDeleted 按会话 ID 记账，替代那个布尔标志

/**
 * 并发合并闸门。
 *
 * 语义：
 *   - 当前没有重建在跑 → 立即执行 job
 *   - 正在跑           → 记一次「再来一次」，并返回**同一个 promise**
 *   - 执行期间来了 N 次请求 → 执行完只补跑 **一次**，不是 N 次
 *
 * 为什么所有调用方都拿同一个 promise：调用方普遍会 await 结果再决定后续
 * 动作（如 chat/service.js 里 buildTree() 失败会等 1 秒后重试）。若合并
 * 进来的调用方拿到 undefined 或上一轮的过期结果，就会做出错误判断。
 *
 * 前提：job 本身不 resolve 成 undefined 之外的无意义值，且不应抛异常
 * （buildTreeOnce 全程 try/catch，实际不会抛）。另：job 若**同步**重入
 * run() 并 await 返回的 promise，会自锁——调用方不应这么用。
 *
 * @returns {(job: () => Promise<any>) => Promise<any>}
 */
export function createBuildGate() {
    /** 进行中的链（含占位 promise，见下方注释） */
    let running = null;
    /** 执行期间是否又有人要重建 */
    let pending = false;

    return function run(job) {
        if (running) {
            // 合并：不新起一轮，只记一次「结束后来一轮」。
            pending = true;
            return running;
        }

        // 先挂占位 promise、后启动 job：这样即使 job() 在自己的第一行同步
        // 重入 run()，此时 running 已经非空，会被记成 pending 而不会无限递归。
        let settle;
        const mine = new Promise((resolve, reject) => {
            settle = { resolve, reject };
        });
        running = mine;

        // run() 多数是 fire-and-forget（事件回调里没人 await），
        // job 将来若改成会抛的，这里兜一层免得产生未处理的 rejection。
        mine.catch(function() { /* 调用方自行处理 */ });

        (async function() {
            let value;
            try {
                do {
                    pending = false;
                    value = await job();
                } while (pending);
                settle.resolve(value);
            } catch (e) {
                settle.reject(e);
            } finally {
                // 只清自己那一份：万一期间有别的实现顶上了 running，别误清。
                if (running === mine) {
                    running = null;
                    pending = false;
                }
            }
        })();

        return mine;
    };
}

/**
 * 「本地刚删掉的会话」记账。
 *
 * 按会话 ID 记账，才能同时做到两件原先布尔标志做不到的事：
 *   - 同一次删除发出的多条 session.deleted（会话 + 子会话）全部被吸收
 *   - 别的会话被删不会被误吞
 *
 * 条目在 TTL 后自然失效（不在读取时顺手删掉）：同一次删除的第 2、3 条事件
 * 应当照样被吸收，用掉即删会漏。会话 ID 不会被复用，因此留着无害；
 * prune 只在写入时顺手清过期项，避免长时间运行后无界增长。
 *
 * @param {number} ttlMs 条目有效期
 * @param {() => number} [now] 时钟，测试可注入假时钟
 */
export function createRecentlyDeleted(ttlMs, now) {
    const clock = now || function() { return Date.now(); };
    /** @type {Map<string, number>} 会话 ID → 被本地删除的时刻 */
    const marks = new Map();

    /** 记下「这个会话刚被本地删了」 */
    function mark(id) {
        if (!id) return false;
        prune();
        marks.set(id, clock());
        return true;
    }

    /** 该会话是否刚被本地删掉（TTL 内） */
    function has(id) {
        if (!id) return false;
        const at = marks.get(id);
        return at !== undefined && (clock() - at) <= ttlMs;
    }

    /** 清掉过期条目 */
    function prune() {
        for (const entry of marks) {
            if (clock() - entry[1] > ttlMs) marks.delete(entry[0]);
        }
    }

    /** 全部清空（切换服务/项目时调用） */
    function clear() {
        marks.clear();
    }

    /** 仅供测试观察内部规模 */
    function size() {
        return marks.size;
    }

    return { mark, has, prune, clear, size };
}

/** 默认 TTL：3 秒。删除的 SSE 事件到达应当远快于此，超时只是退路。 */
export const RECENTLY_DELETED_TTL_MS = 3000;
