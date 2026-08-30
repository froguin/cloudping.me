package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/fatih/color"
	"github.com/rodaine/table"
)

type latencyTest struct {
	Provider CloudProvider
	Region   CloudRegion
	Duration time.Duration
	Err      error
}

func main() {
	providerFlag := flag.String("provider", "", "comma-separated provider keys (default: all)")
	geoFlag := flag.String("geo", "", "comma-separated geos, e.g. Asia,Europe (default: all)")
	concurrency := flag.Int("c", 6, "concurrent pings")
	jsonOut := flag.Bool("json", false, "write a probe snapshot to stdout instead of a table")
	flag.Parse()

	if *concurrency < 1 {
		*concurrency = 1
	}

	providers, err := getCloudProviders()
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to load regions: %v\n", err)
		os.Exit(1)
	}

	selectedProviders := parseCSV(*providerFlag)
	selectedGeos := parseCSV(*geoFlag)

	var jobs []latencyTest
	for _, provider := range providers {
		if len(selectedProviders) > 0 && !selectedProviders[provider.Key] {
			continue
		}
		for _, region := range provider.Regions {
			if region.PingURL == "" {
				continue
			}
			if len(selectedGeos) > 0 && !selectedGeos[region.Geography] {
				continue
			}
			jobs = append(jobs, latencyTest{Provider: provider, Region: region})
		}
	}

	if len(jobs) == 0 {
		fmt.Fprintln(os.Stderr, "no regions matched the given filters")
		os.Exit(1)
	}

	results := make([]latencyTest, len(jobs))
	var done atomic.Int32
	var progressMu sync.Mutex
	jobCh := make(chan int)
	var wg sync.WaitGroup

	fmt.Fprintf(os.Stderr, "Pinging %d regions (concurrency %d)\n", len(jobs), *concurrency)

	for i := 0; i < *concurrency; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range jobCh {
				job := jobs[idx]
				duration, pingErr := ping(job.Region.PingURL)
				job.Duration = duration
				job.Err = pingErr
				results[idx] = job
				finished := done.Add(1)
				progressMu.Lock()
				fmt.Fprintf(os.Stderr, "\r%d/%d", finished, len(jobs))
				progressMu.Unlock()
			}
		}()
	}

	for i := range jobs {
		jobCh <- i
	}
	close(jobCh)
	wg.Wait()
	fmt.Fprintln(os.Stderr)

	var ok, failed []latencyTest
	for _, result := range results {
		if result.Err != nil {
			failed = append(failed, result)
			continue
		}
		ok = append(ok, result)
	}

	if *jsonOut {
		writeJSON(results)
		return
	}

	sort.Slice(ok, func(i, j int) bool {
		return ok[i].Duration < ok[j].Duration
	})
	sort.Slice(failed, func(i, j int) bool {
		if failed[i].Provider.Key == failed[j].Provider.Key {
			return failed[i].Region.Key < failed[j].Region.Key
		}
		return failed[i].Provider.Key < failed[j].Provider.Key
	})

	headerFmt := color.New(color.FgGreen, color.Underline).SprintfFunc()
	columnFmt := color.New(color.FgYellow).SprintfFunc()

	tbl := table.New("#", "Cloud", "Region", "Location", "Latency")
	tbl.WithHeaderFormatter(headerFmt).WithFirstColumnFormatter(columnFmt)

	for i, row := range ok {
		name := row.Provider.DisplayName
		if name == "" {
			name = row.Provider.Key
		}
		tbl.AddRow(
			i+1,
			name,
			row.Region.Key,
			fmt.Sprintf("%s (%s)", row.Region.Location, row.Region.Country),
			fmt.Sprintf("%.0fms", row.Duration.Seconds()*1000),
		)
	}
	tbl.Print()

	if len(failed) > 0 {
		fmt.Fprintf(os.Stderr, "\n%d unreachable:\n", len(failed))
		for _, row := range failed {
			fmt.Fprintf(os.Stderr, "  %s %s: %v\n", row.Provider.Key, row.Region.Key, row.Err)
		}
		os.Exit(1)
	}
}

type probeSnapshot struct {
	Probe struct {
		ID    string `json:"id"`
		Label string `json:"label"`
		At    string `json:"at"`
	} `json:"probe"`
	Results []probeResult `json:"results"`
}

type probeResult struct {
	Provider string `json:"provider"`
	Region   string `json:"region"`
	Location string `json:"location"`
	Country  string `json:"country"`
	Geo      string `json:"geo"`
	Ms       *int   `json:"ms"`
	Ok       bool   `json:"ok"`
}

func writeJSON(results []latencyTest) {
	out := probeSnapshot{}
	out.Probe.ID = "github-actions"
	out.Probe.Label = "GitHub-hosted runner"
	if label := os.Getenv("CLOUDPING_PROBE_LABEL"); label != "" {
		out.Probe.Label = label
	}
	if id := os.Getenv("CLOUDPING_PROBE_ID"); id != "" {
		out.Probe.ID = id
	}
	out.Probe.At = time.Now().UTC().Format(time.RFC3339)
	out.Results = make([]probeResult, 0, len(results))
	for _, row := range results {
		item := probeResult{
			Provider: row.Provider.Key,
			Region:   row.Region.Key,
			Location: row.Region.Location,
			Country:  row.Region.Country,
			Geo:      row.Region.Geography,
			Ok:       row.Err == nil,
		}
		if row.Err == nil {
			ms := int(row.Duration.Milliseconds())
			item.Ms = &ms
		}
		out.Results = append(out.Results, item)
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fmt.Fprintf(os.Stderr, "failed to write json: %v\n", err)
		os.Exit(1)
	}
}

func parseCSV(raw string) map[string]bool {
	out := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		out[part] = true
	}
	return out
}
