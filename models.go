package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"syscall"

	"oc-manager/service"
)

var (
	cachedModels   []string
	cachedModelsMu sync.RWMutex
	cachedModelsOk bool
)

// loadModels 后台加载可用模型列表（线程安全，仅执行一次查询）
func loadModels() {
	cachedModelsMu.Lock()
	defer cachedModelsMu.Unlock()
	if cachedModelsOk {
		return
	}
	models, err := fetchModels()
	if err == nil && len(models) > 0 {
		cachedModels = models
		cachedModelsOk = true
	}
}

// refreshModels 强制刷新可用模型列表
func refreshModels() {
	cachedModelsMu.Lock()
	defer cachedModelsMu.Unlock()
	models, err := fetchModels()
	if err == nil && len(models) > 0 {
		cachedModels = models
		cachedModelsOk = true
	}
}

// getAvailableModels 获取已缓存的可用模型列表
func getAvailableModels() ([]string, error) {
	cachedModelsMu.RLock()
	defer cachedModelsMu.RUnlock()
	if !cachedModelsOk {
		// 如果缓存为空，尝试首次加载
		cachedModelsMu.RUnlock()
		loadModels()
		cachedModelsMu.RLock()
	}
	if cachedModelsOk {
		return cachedModels, nil
	}
	// 紧急回退：直接执行命令
	return fetchModels()
}

// fetchModelsViaHTTP 从已运行的 opencode serve 的 /provider 接口获取模型列表。
func fetchModelsViaHTTP() ([]string, error) {
	status := service.GetWebStatus(service.LastCfgHost, service.LastCfgPort)
	if !status.Running {
		return nil, fmt.Errorf("opencode serve 未运行")
	}

	url := fmt.Sprintf("http://%s:%d/provider", service.LastCfgHost, service.LastCfgPort)
	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var data struct {
		All []struct {
			ID     string `json:"id"`
			Models map[string]struct {
				ID string `json:"id"`
			} `json:"models"`
		} `json:"all"`
	}
	if err := json.Unmarshal(body, &data); err != nil {
		return nil, err
	}

	models := make([]string, 0)
	for _, provider := range data.All {
		for _, modelInfo := range provider.Models {
			models = append(models, provider.ID+"/"+modelInfo.ID)
		}
	}
	return models, nil
}

// fetchModels 获取可用模型列表，优先走 HTTP 接口，失败时回退到 CLI。
func fetchModels() ([]string, error) {
	// 优先用 HTTP 接口，比 CLI 子进程快得多
	if models, err := fetchModelsViaHTTP(); err == nil && len(models) > 0 {
		return models, nil
	}
	// 回退到 CLI
	cmd := exec.Command("opencode", "models")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	output, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	lines := strings.Split(strings.TrimSpace(string(output)), "\n")
	models := make([]string, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line != "" {
			models = append(models, line)
		}
	}
	return models, nil
}
