//go:build feishu

// logf 是包内日志出口。
//
// 单独抽出来而不是各处直接调 log：为的是让「发消息失败」这类
// 失败路径也能记日志而不至于 panic——一条消息发不出去
// 不该拖垮整个事件循环，而静默忽略又会让问题无从排查。
package feishu

import "log"

// logf 记日志。前缀带包名，便于在混在一起的日志里定位。
func logf(format string, args ...any) {
	log.Printf("[feishu] "+format, args...)
}
