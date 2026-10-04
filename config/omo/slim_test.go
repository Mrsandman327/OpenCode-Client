package omo

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"oc-manager/internal/fileutil"
)

// withSlimFile 将 SlimConfigPath 指向临时文件；content 为空时不创建文件。
func withSlimFile(t *testing.T, content string) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "oh-my-opencode-slim.jsonc")
	if content != "" {
		if err := os.WriteFile(path, []byte(content), 0644); err != nil {
			t.Fatalf("写入测试文件失败: %v", err)
		}
	}
	prev := slimPathOverride
	slimPathOverride = path
	t.Cleanup(func() { slimPathOverride = prev })
	return path
}

func readSlimFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取文件失败: %v", err)
	}
	return string(data)
}

func mustValidJSONC(t *testing.T, content string) {
	t.Helper()
	var v interface{}
	if err := json.Unmarshal([]byte(fileutil.StripComments(content)), &v); err != nil {
		t.Fatalf("结果不是有效 JSONC: %v\n内容:\n%s", err, content)
	}
}

// ========== 加载 ==========

func TestLoadSlimOrderAndInherit(t *testing.T) {
	const sample = `{
  // 顶部注释
  "$schema": "https://example/schema.json",
  "preset": "rongsi",
  "presets": {
    "rongsi": {
      "orchestrator": { "model": "deepseek/deepseek-flash", "variant": "max" },
      "explorer": { "model": "deepseek/deepseek-flash", "variant": "low" }
    },
    "省流": {
      "extends": "rongsi",
      "explorer": { "model": "deepseek/deepseek-v4-flash", "variant": "low" }
    }
  },
  "disabled_agents": ["observer"]
}`
	withSlimFile(t, sample)
	res, err := LoadSlimConfig("")
	if err != nil {
		t.Fatalf("加载失败: %v", err)
	}
	if !res.Exists || res.ActivePreset != "rongsi" {
		t.Fatalf("Exists=%v activePreset=%q", res.Exists, res.ActivePreset)
	}
	if len(res.Presets) != 2 {
		t.Fatalf("方案数=%d", len(res.Presets))
	}
	if res.Presets[0].Name != "rongsi" || res.Presets[1].Name != "省流" {
		t.Fatalf("方案顺序错误: %s, %s", res.Presets[0].Name, res.Presets[1].Name)
	}
	if len(res.Presets[0].Agents) != 2 || res.Presets[0].Agents[0].Key != "orchestrator" {
		t.Fatalf("rongsi 行异常: %+v", res.Presets[0].Agents)
	}

	sp := res.Presets[1]
	if sp.Extends != "rongsi" {
		t.Fatalf("extends=%q", sp.Extends)
	}
	if len(sp.Agents) != 2 {
		t.Fatalf("省流合成行数=%d", len(sp.Agents))
	}
	var orch, expl *SlimAgent
	for i := range sp.Agents {
		switch sp.Agents[i].Key {
		case "orchestrator":
			orch = &sp.Agents[i]
		case "explorer":
			expl = &sp.Agents[i]
		}
	}
	if orch == nil || expl == nil {
		t.Fatal("合成结果缺少 orchestrator/explorer")
	}
	if !orch.Inherited || orch.Overridden {
		t.Errorf("orchestrator 应为继承、未覆盖: %+v", *orch)
	}
	if !expl.Inherited || !expl.Overridden {
		t.Errorf("explorer 应为继承且被覆盖: %+v", *expl)
	}
	if expl.Model != "deepseek/deepseek-v4-flash" {
		t.Errorf("explorer 覆盖值=%q", expl.Model)
	}
	if orch.Comment == "" {
		t.Error("描述未填充（内置兜底应有值）")
	}
}

func TestLoadSlimExtendsCycleAndMissing(t *testing.T) {
	withSlimFile(t, `{
  "presets": {
    "a": { "extends": "b", "orchestrator": { "model": "m/a" } },
    "b": { "extends": "a", "orchestrator": { "model": "m/b" } },
    "x": { "extends": "ghost", "orchestrator": { "model": "m/x" } }
  }
}`)
	res, err := LoadSlimConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Presets) != 3 {
		t.Fatalf("方案数=%d", len(res.Presets))
	}
	byName := map[string]SlimPreset{}
	for _, p := range res.Presets {
		byName[p.Name] = p
	}
	if !byName["a"].InheritCycle || !byName["b"].InheritCycle {
		t.Error("a/b 应标记继承环")
	}
	if !byName["x"].InheritMissing {
		t.Error("x 应标记继承源缺失")
	}
}

func TestLoadSlimBlockCommentAndBOM(t *testing.T) {
	sample := "\uFEFF" + `{
  /* 块注释应可解析 */
  "preset": "a",
  "presets": { "a": { "orchestrator": { "model": "m", "variant": "low" } } }
}`
	withSlimFile(t, sample)
	res, err := LoadSlimConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if res.ParseError != "" {
		t.Fatalf("解析失败: %s", res.ParseError)
	}
	if len(res.Presets) != 1 {
		t.Fatalf("方案数=%d", len(res.Presets))
	}
}

// ========== 保存 ==========

func TestSaveLineEditPreservesCommentsAndUnknownFields(t *testing.T) {
	const sample = `{
  // 顶部注释保留
  "$schema": "https://example/schema.json",
  "preset": "rongsi",
  "presets": {
    // 方案注释保留
    "rongsi": {
      "orchestrator": { "model": "old/model", "variant": "low", "skills": ["*"], "mcps": ["*"] }
    }
  },
  "disabled_agents": ["observer"],
  "custom_top": { "keep": true }
}`
	path := withSlimFile(t, sample)
	res, err := LoadSlimConfig("")
	if err != nil {
		t.Fatal(err)
	}
	if err := SaveSlimConfig(SlimSavePayload{
		ActivePreset: "rongsi",
		BaseRevision: res.Revision,
		Presets: []SlimSavePreset{{
			Name:   "rongsi",
			Agents: []SlimSaveAgent{{Key: "orchestrator", Model: "new/model", Variant: "max"}},
		}},
	}); err != nil {
		t.Fatalf("保存失败: %v", err)
	}
	out := readSlimFile(t, path)
	mustValidJSONC(t, out)
	if !strings.Contains(out, "// 顶部注释保留") || !strings.Contains(out, "// 方案注释保留") {
		t.Error("注释丢失（行级路径应保留）")
	}
	if !strings.Contains(out, `"new/model"`) || !strings.Contains(out, `"max"`) {
		t.Errorf("model/variant 未更新:\n%s", out)
	}
	for _, keep := range []string{`"skills"`, `"mcps"`, `"disabled_agents"`, `"custom_top"`} {
		if !strings.Contains(out, keep) {
			t.Errorf("字段丢失: %s", keep)
		}
	}
}

func TestSaveRebuildKeepsTopLevelOnStructureChange(t *testing.T) {
	const sample = `{
  "$schema": "https://example/schema.json",
  "preset": "rongsi",
  "presets": {
    "rongsi": { "orchestrator": { "model": "m", "variant": "low" } }
  },
  "disabled_agents": ["observer"],
  "custom_top": { "keep": true }
}`
	path := withSlimFile(t, sample)
	res, _ := LoadSlimConfig("")
	if err := SaveSlimConfig(SlimSavePayload{
		ActivePreset: "rongsi",
		BaseRevision: res.Revision,
		Presets: []SlimSavePreset{
			{Name: "rongsi", Agents: []SlimSaveAgent{{Key: "orchestrator", Model: "m", Variant: "low"}}},
			{Name: "newone", Agents: []SlimSaveAgent{{Key: "explorer", Model: "e", Variant: "low"}}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	out := readSlimFile(t, path)
	mustValidJSONC(t, out)
	if !strings.Contains(out, `"newone"`) {
		t.Error("新方案未写入")
	}
	if !strings.Contains(out, `"disabled_agents"`) || !strings.Contains(out, `"custom_top"`) {
		t.Error("顶层字段丢失")
	}
}

func TestSaveInheritOnlyWritesDirty(t *testing.T) {
	const sample = `{
  "preset": "rongsi",
  "presets": {
    "rongsi": { "orchestrator": { "model": "m1", "variant": "max" }, "explorer": { "model": "m2", "variant": "low" } },
    "省流": { "extends": "rongsi", "explorer": { "model": "cheap", "variant": "low" } }
  }
}`
	path := withSlimFile(t, sample)
	res, _ := LoadSlimConfig("")
	if err := SaveSlimConfig(SlimSavePayload{
		ActivePreset: "rongsi",
		BaseRevision: res.Revision,
		Presets: []SlimSavePreset{
			{Name: "rongsi", Agents: []SlimSaveAgent{
				{Key: "orchestrator", Model: "m1", Variant: "max"},
				{Key: "explorer", Model: "m2", Variant: "low"},
			}},
			{Name: "省流", Extends: "rongsi", Agents: []SlimSaveAgent{
				{Key: "orchestrator", Model: "m1", Variant: "max"},               // 继承，不落盘
				{Key: "explorer", Model: "cheaper", Variant: "low", Dirty: true}, // 覆盖
			}},
		},
	}); err != nil {
		t.Fatal(err)
	}
	out := readSlimFile(t, path)
	mustValidJSONC(t, out)
	if !strings.Contains(out, `"extends": "rongsi"`) {
		t.Error("extends 丢失")
	}
	if !strings.Contains(out, "cheaper") {
		t.Errorf("覆盖值未写入:\n%s", out)
	}
	// 重新加载：orchestrator 应仍是"纯继承”，未被物化成覆盖
	res2, _ := LoadSlimConfig("")
	for _, p := range res2.Presets {
		if p.Name != "省流" {
			continue
		}
		for _, a := range p.Agents {
			if a.Key == "orchestrator" && a.Overridden {
				t.Error("继承行被误写为覆盖")
			}
		}
	}
}

func TestSaveExplicitDeleteAndScratchCreate(t *testing.T) {
	// 场景1：显式删除方案
	const sample = `{
  "preset": "a",
  "presets": { "a": { "orchestrator": { "model": "m", "variant": "low" } }, "b": { "orchestrator": { "model": "n", "variant": "low" } } }
}`
	path := withSlimFile(t, sample)
	res, _ := LoadSlimConfig("")
	if err := SaveSlimConfig(SlimSavePayload{
		ActivePreset: "a",
		BaseRevision: res.Revision,
		Presets: []SlimSavePreset{
			{Name: "a", Agents: []SlimSaveAgent{{Key: "orchestrator", Model: "m", Variant: "low"}}},
			{Name: "b", Deleted: true},
		},
	}); err != nil {
		t.Fatal(err)
	}
	out := readSlimFile(t, path)
	mustValidJSONC(t, out)
	if strings.Contains(out, `"b"`) {
		t.Errorf("显式删除的方案仍存在:\n%s", out)
	}

	// 场景2：文件不存在时从零创建
	path2 := withSlimFile(t, "")
	if err := SaveSlimConfig(SlimSavePayload{
		ActivePreset: "rongsi",
		Presets:      []SlimSavePreset{{Name: "rongsi", Agents: []SlimSaveAgent{{Key: "orchestrator", Model: "m", Variant: "max"}}}},
	}); err != nil {
		t.Fatalf("从零创建失败: %v", err)
	}
	out2 := readSlimFile(t, path2)
	mustValidJSONC(t, out2)
	if !strings.Contains(out2, `"preset": "rongsi"`) || !strings.Contains(out2, `"rongsi"`) {
		t.Errorf("创建内容不完整:\n%s", out2)
	}
}

func TestSaveConflictDetected(t *testing.T) {
	const sample = `{ "preset": "a", "presets": { "a": { "orchestrator": { "model": "m", "variant": "low" } } } }`
	path := withSlimFile(t, sample)
	res, _ := LoadSlimConfig("")
	// 模拟外部（插件 /preset 或编辑器）修改
	if err := os.WriteFile(path, []byte(`{ "preset": "b", "presets": { "b": {} } }`), 0644); err != nil {
		t.Fatal(err)
	}
	err := SaveSlimConfig(SlimSavePayload{
		ActivePreset: "a",
		BaseRevision: res.Revision,
		Presets:      []SlimSavePreset{{Name: "a", Agents: []SlimSaveAgent{{Key: "orchestrator", Model: "m", Variant: "low"}}}},
	})
	if err == nil {
		t.Fatal("应检测到外部修改冲突")
	}
	if !strings.Contains(err.Error(), "外部修改") {
		t.Errorf("错误信息不符: %v", err)
	}
}

// 回归：文件以注释开头时，根容器定位不能被注释行带偏（曾导致保存产出无效 JSON）。
func TestSaveFileStartingWithComments(t *testing.T) {
	const sample = `// 顶部注释一
// 顶部注释二
{
  // 方案内注释
  "preset": "a",
  "presets": {
    "a": {
      "orchestrator": { "model": "m1", "variant": "low" }
    }
  },
  "disabled_agents": ["observer"]
}`
	path := withSlimFile(t, sample)
	res, err := LoadSlimConfig("")
	if err != nil {
		t.Fatal(err)
	}
	// 结构未变 → 行级替换，应保留注释
	if err := SaveSlimConfig(SlimSavePayload{
		ActivePreset: "a",
		BaseRevision: res.Revision,
		Presets:      []SlimSavePreset{{Name: "a", Agents: []SlimSaveAgent{{Key: "orchestrator", Model: "m1", Variant: "high"}}}},
	}); err != nil {
		t.Fatalf("行级保存失败: %v", err)
	}
	out := readSlimFile(t, path)
	mustValidJSONC(t, out)
	if !strings.Contains(out, "// 顶部注释一") || !strings.Contains(out, "// 方案内注释") {
		t.Errorf("注释丢失（以注释开头的文件应能正确定位）:\n%s", out)
	}
	if !strings.Contains(out, `"high"`) {
		t.Errorf("variant 未更新:\n%s", out)
	}

	// 结构变化 → 重建，块外内容（含顶部注释）保留
	if err := SaveSlimConfig(SlimSavePayload{
		ActivePreset: "a",
		BaseRevision: contentRevision([]byte(out)),
		Presets: []SlimSavePreset{
			{Name: "a", Agents: []SlimSaveAgent{{Key: "orchestrator", Model: "m1", Variant: "high"}}},
			{Name: "b", Agents: []SlimSaveAgent{{Key: "explorer", Model: "e", Variant: "low"}}},
		},
	}); err != nil {
		t.Fatalf("重建保存失败: %v", err)
	}
	out2 := readSlimFile(t, path)
	mustValidJSONC(t, out2)
	if !strings.Contains(out2, `"b"`) || !strings.Contains(out2, `"disabled_agents"`) || !strings.Contains(out2, "// 顶部注释一") {
		t.Errorf("重建结果不完整:\n%s", out2)
	}
}
