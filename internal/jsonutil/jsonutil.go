// Package jsonutil 提供 JSON 反序列化结果的轻量类型转换 helper，
// 统一原先散落在 config/provider、service/opencode 等处的本地实现。
package jsonutil

import (
	"encoding/json"
	"fmt"
)

// String 把任意 JSON 反序列化值转为字符串：
// string 原样返回；实现了 fmt.Stringer 的值取其 String()；其余返回 ""。
func String(v any) string {
	switch s := v.(type) {
	case string:
		return s
	case fmt.Stringer:
		return s.String()
	default:
		return ""
	}
}

// Int64 把 JSON 数字值转为 int64；无法转换时返回 0。
func Int64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	}
	return 0
}

// Float64 把 JSON 数字值转为 float64；无法转换时返回 0。
func Float64(v any) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return 0
}

// RawString 把 json.RawMessage 解析为字符串；失败或空返回 ""。
func RawString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) != nil {
		return ""
	}
	return s
}

// RawMap 把 json.RawMessage 解析为 map[string]interface{}；失败返回 nil。
func RawMap(raw json.RawMessage) map[string]interface{} {
	if len(raw) == 0 {
		return nil
	}
	var m map[string]interface{}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return m
}
