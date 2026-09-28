<#
.SYNOPSIS
    Universal 1-Click k6 Load Test Runner with Auto-HAR Conversion & Live Grafana Dashboard
.DESCRIPTION
    Runs load tests for ANY HAR file automatically. If a new .har file is supplied or dropped
    into har_files/, this runner automatically converts it into a telemetry-enabled k6 script,
    binds real account credentials, and triggers the load test without manual coding.
.EXAMPLE
    .\run_load_test.ps1 prepespro2 -VUs 50
.EXAMPLE
    .\run_load_test.ps1 -Har "prepespro3.har" -VUs 100 -Duration "1m"
.EXAMPLE
    .\run_load_test.ps1 -VUs 50
#>

param(
    [Parameter(Position=0)]
    [string]$Har = "",

    [Parameter(Position=1)]
    [int]$VUs = 0,

    [string]$Duration = "",
    [string]$Script = "",
    [string]$ScriptPath = ""
)

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "   ⚡ Universal Grafana k6 Enterprise Load Testing Suite ⚡" -ForegroundColor Yellow
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Ensure Telemetry & Grafana Server is running on ports 3001 and 5665
$serverRunning = Get-NetTCPConnection -LocalPort 3001 -ErrorAction SilentlyContinue
if (-not $serverRunning) {
    Write-Host "[Setup] Starting background telemetry server (Ports 3001 & 5665)..." -ForegroundColor Gray
    Start-Process node -ArgumentList "tests/christ_university/reports/report_server.js" -WindowStyle Hidden
    Start-Sleep -Seconds 1
}

# 2. Discover all available HAR recordings in har_files/
$harDir = Join-Path $PSScriptRoot "har_files"
$allHars = @(Get-ChildItem -Path $harDir -Filter "*.har" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)

# 3. Resolve target HAR / Script
$targetHarFile = $null
$targetScriptFile = ""

if (-not [string]::IsNullOrWhiteSpace($ScriptPath)) {
    $targetScriptFile = $ScriptPath
} elseif (-not [string]::IsNullOrWhiteSpace($Script)) {
    if ($Script -eq "1") {
        $targetScriptFile = "tests/prepespro_har_load_test.js"
    } elseif ($Script -eq "2") {
        $targetScriptFile = "tests/prepespro2_har_load_test.js"
    } else {
        $targetScriptFile = $Script
    }
} elseif (-not [string]::IsNullOrWhiteSpace($Har)) {
    # Check if $Har is a direct file path
    if (Test-Path $Har) {
        $targetHarFile = Get-Item $Har
    } else {
        # Search by filename or version keyword in har_files
        $matched = $allHars | Where-Object { 
            $_.Name -like "*$Har*" -or $_.BaseName -like "*$Har*"
        }
        if ($matched.Count -ge 1) {
            $targetHarFile = $matched[0]
        } else {
            Write-Host "[Warning] No HAR file matching '$Har' found in $harDir." -ForegroundColor Red
        }
    }
}

# If still not resolved, prompt developer with an interactive list of all HAR files found
if ($null -eq $targetHarFile -and [string]::IsNullOrWhiteSpace($targetScriptFile)) {
    if ($allHars.Count -eq 0) {
        Write-Host "[Error] No .har files found in $harDir. Please drop your recording there." -ForegroundColor Red
        exit 1
    }

    Write-Host "`nDiscovered HAR Recordings in har_files/:" -ForegroundColor Yellow
    for ($i = 0; $i -lt $allHars.Count; $i++) {
        $h = $allHars[$i]
        $tag = if ($i -eq 0) { " [LATEST]" } else { "" }
        $sizeKb = [math]::Round($h.Length / 1KB, 1)
        Write-Host "  [$($i+1)] $($h.Name) (${sizeKb} KB)$tag"
    }

    $promptChoice = Read-Host "`nSelect a HAR recording [1-$($allHars.Count), or enter name/version, Default: 1]"
    if ([string]::IsNullOrWhiteSpace($promptChoice) -or $promptChoice -eq "1") {
        $targetHarFile = $allHars[0]
    } elseif ($promptChoice -match '^\d+$' -and [int]$promptChoice -le $allHars.Count) {
        $targetHarFile = $allHars[[int]$promptChoice - 1]
    } else {
        $matched = $allHars | Where-Object { $_.Name -like "*$promptChoice*" }
        if ($matched.Count -ge 1) {
            $targetHarFile = $matched[0]
        } else {
            $targetHarFile = $allHars[0]
        }
    }
}

# 4. Automatic Script Resolution & On-the-Fly HAR Conversion
if ($targetHarFile -ne $null) {
    # Established curated scripts
    if ($targetHarFile.Name -eq "prepespro.christuniversity.in.har") {
        $targetScriptFile = "tests/prepespro_har_load_test.js"
    } elseif ($targetHarFile.Name -eq "prepespro2.christuniversity.in.har") {
        $targetScriptFile = "tests/prepespro2_har_load_test.js"
    } else {
        $cleanBase = $targetHarFile.BaseName -replace '[^a-zA-Z0-9_-]', '_'
        $targetScriptFile = "tests/${cleanBase}_load_test.js"
    }

    # If the target script doesn't exist OR the HAR file was updated more recently than the script, auto-convert!
    $needConversion = $false
    if (-not (Test-Path $targetScriptFile)) {
        $needConversion = $true
    } else {
        $scriptItem = Get-Item $targetScriptFile
        if ($targetHarFile.LastWriteTime -gt $scriptItem.LastWriteTime) {
            $needConversion = $true
        }
    }

    if ($needConversion) {
        Write-Host "`n[Auto-Convert] Converting '$($targetHarFile.Name)' into k6 load test script..." -ForegroundColor Yellow
        & node tools/convert_har.js "$($targetHarFile.FullName)" "$targetScriptFile"
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[Error] Failed to convert HAR file." -ForegroundColor Red
            exit 1
        }
    }
}

# 5. Prompt for VUs if not supplied
if ($VUs -le 0) {
    $vuInput = Read-Host "Enter number of Virtual Users (VUs) to simulate [Default: 1]"
    if ([string]::IsNullOrWhiteSpace($vuInput)) {
        $VUs = 1
    } else {
        $VUs = [int]$vuInput
    }
}

# 6. Prompt for Duration if not supplied
if ([string]::IsNullOrWhiteSpace($Duration)) {
    $durInput = Read-Host "Enter test duration (e.g. 30s, 1m, 5m) or press Enter for 1 iteration per VU [Default: 1 iteration per VU]"
    if (-not [string]::IsNullOrWhiteSpace($durInput)) {
        $Duration = $durInput
    }
}

Write-Host "`n[Execution Plan]" -ForegroundColor Green
Write-Host " • HAR Source      : $(if ($targetHarFile) { $targetHarFile.Name } else { 'Direct Script' })"
Write-Host " • Target Script   : $targetScriptFile"
Write-Host " • Virtual Users   : $VUs VU(s)"
Write-Host " • Execution Mode  : $(if ($Duration) { "$Duration duration limit" } else { "1 Full User Journey Iteration per VU ($VUs total iterations)" })"
Write-Host " • Real Accounts   : tests/data/prepespro_credentials.csv (Auto-Distributed)"
Write-Host " • Grafana Engine  : Active (Port 5665)"
Write-Host " • Download Portal : Active (Port 3001)"
Write-Host "------------------------------------------------------------`n" -ForegroundColor Gray

# 7. Configure environment for Grafana export
$env:K6_WEB_DASHBOARD = "true"
$env:K6_WEB_DASHBOARD_PORT = "5665"
$env:K6_WEB_DASHBOARD_EXPORT = "tests/christ_university/reports/grafana_report.html"

# 8. Build command arguments
$k6Args = @("run", "-u", "$VUs")
if ($Duration) {
    $k6Args += @("-d", "$Duration")
} else {
    $k6Args += @("-i", "$VUs")
}
$k6Args += "$targetScriptFile"

Write-Host "[Running] k6 $($k6Args -join ' ')...`n" -ForegroundColor Cyan
& k6.exe $k6Args

# 9. Refresh CSV & Summary
Write-Host "`n[Post-Processing] Generating updated metrics and downloads..." -ForegroundColor Gray
try {
    Invoke-WebRequest -Uri "http://localhost:3001/download/csv" -OutFile "tests/christ_university/reports/grafana_api_metrics.csv" -UseBasicParsing -ErrorAction SilentlyContinue | Out-Null
} catch {}

# 10. Open Dashboards
Write-Host "`n[Done] Load test completed!" -ForegroundColor Green
Write-Host " • Live Grafana Dashboard : http://127.0.0.1:5665" -ForegroundColor Yellow
Write-Host " • Download Portal (CSV)  : http://localhost:3001" -ForegroundColor Yellow

Start-Process "http://127.0.0.1:5665"
Start-Process "http://localhost:3001"
