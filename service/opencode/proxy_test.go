package opencode

import "testing"

// TestBuildNoProxy 校验 NO_PROXY 的默认值与用户追加规则：
//   - 默认始终包含 localhost 与 127.0.0.1；
//   - 用户输入按逗号拆分、去空白、去重（大小写不敏感）；
//   - 域名后缀与 CIDR 原样保留。
func TestBuildNoProxy(t *testing.T) {
	cases := []struct {
		extra string
		want  string
	}{
		{"", "localhost,127.0.0.1"},
		{"10.0.0.0/8", "localhost,127.0.0.1,10.0.0.0/8"},
		{" 10.0.0.0/8 , 192.168.0.0/16 ", "localhost,127.0.0.1,10.0.0.0/8,192.168.0.0/16"},
		{"localhost,127.0.0.1", "localhost,127.0.0.1"},
		{"LOCALHOST, 10.1.1.1", "localhost,127.0.0.1,10.1.1.1"},
		{",, .corp.example ,,", "localhost,127.0.0.1,.corp.example"},
	}
	for _, tc := range cases {
		if got := buildNoProxy(tc.extra); got != tc.want {
			t.Errorf("buildNoProxy(%q) = %q, want %q", tc.extra, got, tc.want)
		}
	}
}
