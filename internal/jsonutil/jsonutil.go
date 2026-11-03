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
