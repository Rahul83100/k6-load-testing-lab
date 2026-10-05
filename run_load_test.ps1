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
    [string]$ScriptPath = "",
    [string]$Csv = ""
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
$harDir = if ($PSScriptRoot) { Join-Path $PSScriptRoot "har_files" } else { "har_files" }
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
        $matched = @($allHars | Where-Object { 
            $_.Name -like "*$Har*" -or $_.BaseName -like "*$Har*"
        })
        if ($matched.Count -ge 1) {
            $targetHarFile = $matched[0]
        } else {
            Write-Host "[Warning] No HAR file matching '$Har' found in $harDir." -ForegroundColor Red
        }
    }
}

# If still not resolved, check default or prompt
if ($null -eq $targetHarFile -and [string]::IsNullOrWhiteSpace($targetScriptFile)) {
    if ($allHars.Count -eq 0) {
        Write-Host "[Error] No .har files found in $harDir. Please drop your recording there." -ForegroundColor Red
        exit 1
    }

    # If running non-interactively or with VUs set, pick latest
    if ($VUs -gt 0 -or [Console]::IsInputRedirected) {
        $targetHarFile = $allHars[0]
    } else {
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
            $m = @($allHars | Where-Object { $_.Name -like "*$promptChoice*" })
            if ($m.Count -ge 1) {
                $targetHarFile = $m[0]
            } else {
                $targetHarFile = $allHars[0]
            }
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

# 5. Default VUs if not supplied
if ($VUs -le 0) {
    if (-not [Console]::IsInputRedirected) {
        $vuInput = Read-Host "Enter number of Virtual Users (VUs) to simulate [Default: 1]"
        $VUs = if ([string]::IsNullOrWhiteSpace($vuInput)) { 1 } else { [int]$vuInput }
    } else {
        $VUs = 1
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

# Resolve custom CSV credentials if specified
$csvEnvPath = "./data/students.csv"
if (-not [string]::IsNullOrWhiteSpace($Csv)) {
    if (Test-Path $Csv) {
        $csvEnvPath = $Csv
    } elseif (Test-Path "tests/data/$Csv") {
        $csvEnvPath = "./data/$Csv"
    } else {
        $csvEnvPath = $Csv
    }
    Write-Host " • Custom CSV File : $csvEnvPath"
}
$env:CREDENTIALS_FILE = $csvEnvPath
$env:VUS = "$VUs"
$env:DURATION = if ($Duration) { "$Duration" } else { "" }
$env:ITERS = if ($Duration) { "" } else { "$VUs" }

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

# Temporarily release port 5665 from report_server so k6 can bind its live web dashboard
try { Invoke-RestMethod -Uri "http://localhost:3001/api/release-5665" -Method Post -TimeoutSec 2 -ErrorAction SilentlyContinue | Out-Null } catch {}

Write-Host "[Running] k6 $($k6Args -join ' ')...`n" -ForegroundColor Cyan
& k6.exe $k6Args

# Reclaim port 5665 so it persistently serves the exported Grafana report even after k6 finishes
try { Invoke-RestMethod -Uri "http://localhost:3001/api/claim-5665" -Method Post -TimeoutSec 2 -ErrorAction SilentlyContinue | Out-Null } catch {}

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
