package main

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

var httpClient = &http.Client{
	Timeout: 8 * time.Second,
}

func withCacheBuster(rawURL string) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	query := parsed.Query()
	query.Set("_cloudping", fmt.Sprintf("%d", time.Now().UnixNano()))
	parsed.RawQuery = query.Encode()
	return parsed.String(), nil
}

func timedGet(rawURL string) (time.Duration, error) {
	target, err := withCacheBuster(rawURL)
	if err != nil {
		return 0, err
	}

	req, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("User-Agent", "cloudping.me-cli")

	start := time.Now()
	resp, err := httpClient.Do(req)
	elapsed := time.Since(start)
	if resp != nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}
	if err != nil {
		return 0, err
	}
	return elapsed, nil
}

func ping(rawURL string) (time.Duration, error) {
	_, _ = timedGet(rawURL)

	elapsed, err := timedGet(rawURL)
	if err != nil {
		return 0, err
	}
	if elapsed < 2*time.Millisecond {
		return 0, fmt.Errorf("network error")
	}
	return elapsed, nil
}
