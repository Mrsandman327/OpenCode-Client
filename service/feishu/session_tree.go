// session_tree.go —— 会话建树
//
// 对应 opencode-feishu-bot 的 src/opencode/session-tree.ts，
// 连同其「按层级识别子会话」的修复一并移植（bot 侧 fbc48e5）。
//
// 问题的由来：V2 的子代理（subagent）会话与主会话同目录共存，
// 实测最近 50 条里 39 条（78%）是子会话。平铺展示时主会话被彻底淹没。
//
// 一次查询 + 本地建树，而非逐个会话查子会话：
// 逐个查是 N+1 次请求，且查不满——父会话不在本页时无从知道它有子会话。
package feishu

import (
	"sort"
	"time"
)

// maxChildrenPerRoot 是每个主会话最多展示的子会话数。
//
// 子会话数量常常远超主会话（实测一个主会话能派生十几个子代理），
// 不限的话一张卡片塞不下。
const maxChildrenPerRoot = 5

// BuildSessionTree 把扁平的会话列表建成树。
//
// @returns nodes 是主会话树；unattached 是「父会话不在本列表内」的子会话数。
//
// 这些子会话无法归属，只能如实计数告知用户，不能静默丢弃——
// 数据少了用户不知道，就会以为系统漏了东西。
func BuildSessionTree(list []SessionSummary) (nodes []SessionNode, unattached int) {
	byID := make(map[string]*SessionSummary, len(list))
	for i := range list {
		byID[list[i].ID] = &list[i]
	}

	// 先造全部节点（子节点也需要存在才能挂到父下）
	all := make(map[string]*SessionNode, len(list))
	for i := range list {
		s := list[i]
		all[s.ID] = &SessionNode{
			ID:       s.ID,
			Title:    s.Title,
			ParentID: s.ParentID,
			Updated:  millisToTime(s.Updated),
		}
	}

	// **必须先把所有子节点挂到父上，再收集根节点。**
	//
	// 反过来写（边遍历边把根节点拷进结果数组）会**丢掉全部子节点**：
	// 根节点在挂子之前就被拷走了，之后挂到 map 里那份的子节点
	// 不会反映到结果数组的那份拷贝上。症状是「子会话全没了」——
	// 而这恰好是本函数要解决的核心问题。
	for i := range list {
		s := list[i]
		if s.ParentID == "" {
			continue
		}
		if _, ok := byID[s.ParentID]; !ok {
			// 父会话不在本次结果里：无法归属，如实计数
			unattached++
			continue
		}
		all[s.ParentID].Children = append(all[s.ParentID].Children, *all[s.ID])
	}

	// 挂子完成后才收集根节点
	for i := range list {
		if list[i].ParentID == "" {
			nodes = append(nodes, *all[list[i].ID])
		}
	}

	sortTree(nodes)
	applyChildLimit(nodes)
	return nodes, unattached
}

// sortTree 递归按更新时间倒序排。
//
// 最新的在前：用户要找的几乎总是最近在用的那几个。
func sortTree(nodes []SessionNode) {
	sort.SliceStable(nodes, func(i, j int) bool {
		return nodes[i].Updated.After(nodes[j].Updated)
	})
	for i := range nodes {
		if len(nodes[i].Children) > 0 {
			sortTree(nodes[i].Children)
		}
	}
}

// applyChildLimit 限制每个节点的子会话展示数，把余量记进 HiddenChildCount。
func applyChildLimit(nodes []SessionNode) {
	for i := range nodes {
		if len(nodes[i].Children) > maxChildrenPerRoot {
			nodes[i].HiddenChildCount = len(nodes[i].Children) - maxChildrenPerRoot
			nodes[i].Children = nodes[i].Children[:maxChildrenPerRoot]
		}
		if len(nodes[i].Children) > 0 {
			applyChildLimit(nodes[i].Children)
		}
	}
}

// millisToTime 把毫秒时间戳转 time.Time；0 或非法值返回零值。
func millisToTime(ms int64) time.Time {
	if ms <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}
