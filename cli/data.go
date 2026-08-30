package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

type CloudProvider struct {
	Key         string        `json:"key"`
	DisplayName string        `json:"display_name"`
	ShortName   string        `json:"short_name,omitempty"`
	Regions     []CloudRegion `json:"-"`
}

type CloudRegion struct {
	Key         string `json:"key"`
	DisplayName string `json:"display_name"`
	Country     string `json:"country"`
	Location    string `json:"location"`
	Geography   string `json:"geo"`
	PingURL     string `json:"ping_url"`
}

func findDataDir() (string, error) {
	if env := os.Getenv("CLOUDPING_DATA"); env != "" {
		if hasProviders(env) {
			return env, nil
		}
		return "", fmt.Errorf("CLOUDPING_DATA=%s does not contain providers.json", env)
	}

	var starts []string
	if cwd, err := os.Getwd(); err == nil {
		starts = append(starts, cwd)
	}
	if exe, err := os.Executable(); err == nil {
		starts = append(starts, filepath.Dir(exe))
	}

	seen := map[string]bool{}
	for _, start := range starts {
		dir := start
		for i := 0; i < 8; i++ {
			cand := filepath.Join(dir, "src", "data", "datasource")
			if !seen[cand] {
				seen[cand] = true
				if hasProviders(cand) {
					return cand, nil
				}
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}

	return "", fmt.Errorf("could not find src/data/datasource (run from the cloudping.me repo)")
}

func hasProviders(dir string) bool {
	st, err := os.Stat(filepath.Join(dir, "providers.json"))
	return err == nil && !st.IsDir()
}

func getCloudProviders() ([]CloudProvider, error) {
	dir, err := findDataDir()
	if err != nil {
		return nil, err
	}

	raw, err := os.ReadFile(filepath.Join(dir, "providers.json"))
	if err != nil {
		return nil, err
	}

	var providers []CloudProvider
	if err := json.Unmarshal(raw, &providers); err != nil {
		return nil, err
	}

	for i, provider := range providers {
		regionPath := filepath.Join(dir, "regions", provider.Key+".json")
		regionRaw, err := os.ReadFile(regionPath)
		if err != nil {
			return nil, fmt.Errorf("regions for %s: %w", provider.Key, err)
		}
		var regions []CloudRegion
		if err := json.Unmarshal(regionRaw, &regions); err != nil {
			return nil, fmt.Errorf("regions for %s: %w", provider.Key, err)
		}
		providers[i].Regions = regions
	}

	return providers, nil
}
