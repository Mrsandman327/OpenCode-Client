package main

import "testing"

// TestNormalizeVersion 覆盖版本号归一化。
func TestNormalizeVersion(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"2.0.15", "2.0.15"},
		{"v2.0.15", "2.0.15"},
		{"V2.0.15", "2.0.15"},
		{"  v1.18.33  ", "1.18.33"},
		{"0.0.0-dev-202609280537", "0.0.0-dev-202609280537"},
		{"", ""},
	}
	for _, c := range cases {
		if got := normalizeVersion(c.in); got != c.want {
			t.Errorf("normalizeVersion(%q) = %q, 期望 %q", c.in, got, c.want)
		}
	}
}

// TestCompareVersions 重点覆盖本次修复的回归场景：
// 旧实现用字符串相等判断，v2 用户会被告知「有新版本 v1.18.33」。
func TestCompareVersions(t *testing.T) {
	cases := []struct {
		a, b string
		want int
		why  string
	}{
		{"2.0.15", "2.0.18", -1, "同主次版本，补丁号落后 → 有更新"},
		{"2.0.18", "2.0.18", 0, "完全相同 → 已是最新"},
		{"2.0.20", "2.0.18", 1, "本地比远端新 → 不应提示降级"},
		{"2.0.9", "2.0.18", -1, "字符串比较会误判，此处必须按数值比较"},
		{"1.18.33", "2.0.18", -1, "跨大版本 → 应提示升级"},
		{"2.0.0", "2.0.0-beta", 1, "正式版新于预发布版"},
		{"2.0.0-beta", "2.0.0-beta", 0, "同为预发布版"},
		{"2.0.0-alpha", "2.0.0-beta", -1, "预发布版之间按后缀比较"},
		{"2.0", "2.0.0", 0, "缺失段按 0 处理"},
		{"2", "2.0.0", 0, "只有主版本号"},
		{"2.0.15", "2.0.15-rc1", 1, "本地正式版 vs 远端预发布版"},
		{"0.0.0-dev-202609280537", "2.0.18", -1, "快照版视为最旧"},
	}
	for _, c := range cases {
		if got := compareVersions(c.a, c.b); got != c.want {
			t.Errorf("compareVersions(%q, %q) = %d, 期望 %d（%s）", c.a, c.b, got, c.want, c.why)
		}
	}
}

// TestSameMajor 覆盖 GitHub Releases 兜底的主版本校验。
func TestSameMajor(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"2.0.15", "2.0.18", true},
		{"2.0.15", "1.18.33", false}, // 关键：v2 用户不能被指向 v1 的 tag
		{"1.18.33", "1.18.34", true},
		{"2.0.15", "", false},
		{"", "", false},
	}
	for _, c := range cases {
		if got := sameMajor(c.a, c.b); got != c.want {
			t.Errorf("sameMajor(%q, %q) = %v, 期望 %v", c.a, c.b, got, c.want)
		}
	}
}

// TestParseVersion 覆盖解析细节。
func TestParseVersion(t *testing.T) {
	cases := []struct {
		in         string
		wantNums   [3]int
		wantPre    string
	}{
		{"2.0.15", [3]int{2, 0, 15}, ""},
		{"v2.0.15", [3]int{2, 0, 15}, ""},
		{"2.0", [3]int{2, 0, 0}, ""},
		{"2", [3]int{2, 0, 0}, ""},
		{"1.2.3-beta.4", [3]int{1, 2, 3}, "beta.4"},
		{"1.2.3-rc1", [3]int{1, 2, 3}, "rc1"},
		{"0.0.0-dev-202609280537", [3]int{0, 0, 0}, "dev-202609280537"},
		{"", [3]int{0, 0, 0}, ""},
	}
	for _, c := range cases {
		nums, pre := parseVersion(c.in)
		if nums != c.wantNums || pre != c.wantPre {
			t.Errorf("parseVersion(%q) = %v,%q, 期望 %v,%q", c.in, nums, pre, c.wantNums, c.wantPre)
		}
	}
}

// TestCheckOpenCodeVersionInvalidInput 校验非法当前版本的报错路径。
func TestCheckOpenCodeVersionInvalidInput(t *testing.T) {
	r := checkOpenCodeVersion("")
	if r.Error == "" {
		t.Errorf("空版本号应返回错误，实际 %+v", r)
	}
	if !r.IsLatest {
		t.Errorf("无法判断时 IsLatest 应保持 true（避免误报有更新），实际 %v", r.IsLatest)
	}
}
