package localmodels

import (
	"context"
	"net/url"
	"strings"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// loopbackHealthURL parses rawURL as a loopback HTTP endpoint and returns its
// /health URL, or an empty string when rawURL is empty, invalid, or not on
// loopback. When stripV1 is true, a trailing /v1 segment is removed first,
// matching localmodels' own engine health check.
func loopbackHealthURL(rawURL string, stripV1 bool) string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme != "http" || parsed.Port() == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return ""
	}
	switch parsed.Hostname() {
	case "127.0.0.1", "localhost", "::1":
	default:
		return ""
	}
	path := strings.TrimRight(parsed.Path, "/")
	if stripV1 {
		path = strings.TrimSuffix(path, "/v1")
	}
	return parsed.Scheme + "://" + parsed.Host + path + "/health"
}

// localGatewayHealthURL returns the saved local Bifrost gateway's loopback
// /health URL when stateDir's model-source.json is in local mode, else "".
func localGatewayHealthURL(stateDir string) string {
	if stateDir == "" {
		return ""
	}
	overlay := ReadOverlay(stateDir)
	if overlay == nil || overlay.Mode != "local" {
		return ""
	}
	return loopbackHealthURL(overlay.GatewayURL, false)
}

// loadedEndpointHealthy probes a cached or refreshed loaded model's loopback
// engine endpoint and, when model-source.json names a local loopback gateway,
// that gateway as well. Non-loopback or missing URLs are not probed.
func (l *Library) loadedEndpointHealthy(ctx context.Context, row wire.LocalModel) bool {
	if row.Endpoint != nil && row.Endpoint.BaseURL != "" {
		if healthURL := loopbackHealthURL(row.Endpoint.BaseURL, true); healthURL != "" && !l.healthCheck(ctx, healthURL) {
			return false
		}
	}
	if l.tool != nil {
		if healthURL := localGatewayHealthURL(l.tool.StateDirectory); healthURL != "" && !l.healthCheck(ctx, healthURL) {
			return false
		}
	}
	return true
}

// needsUnloadBeforeLoad reports whether modelID holds a stale loaded record
// that must be reset to idle before loading: a server that failed its health
// check, or a loaded server whose endpoint or local gateway does not answer.
func (l *Library) needsUnloadBeforeLoad(ctx context.Context, modelID string) bool {
	l.mu.Lock()
	row := l.rowLocked(func(model wire.LocalModel) bool { return model.ID == modelID })
	l.mu.Unlock()
	if row == nil {
		return false
	}
	if row.State == "failed" && row.Error != nil && row.Error.Code == "HEALTH_CHECK_FAILED" {
		return true
	}
	return row.State == "loaded" && !l.loadedEndpointHealthy(ctx, *row)
}
