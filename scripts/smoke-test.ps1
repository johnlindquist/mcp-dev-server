# PowerShell script to run Node with a timeout guard.
# Success = Exit code 0 OR timeout occurred.

param(
    [int]$TimeoutSeconds = 3 # Default timeout in seconds
)

$ProcessName = "node"
$Arguments = "build/index.mjs"
$TimeoutMilliseconds = $TimeoutSeconds * 1000
$ExitCode = 1 # Default to failure

Write-Host "Starting process '$ProcessName $Arguments' with ${TimeoutSeconds}s guard..."
$p = Start-Process -FilePath $ProcessName -ArgumentList $Arguments -PassThru -NoNewWindow

if ($null -eq $p) {
    Write-Error "Failed to start process."
    exit 1
}

Write-Host "Process started with PID: $($p.Id). Waiting for $TimeoutSeconds seconds..."

try {
    $exited = $p.WaitForExit($TimeoutMilliseconds)

    if ($exited) {
        $ExitCode = $p.ExitCode
        Write-Host "Process exited naturally with code: $ExitCode"
    } else {
        Write-Host "⏳ Timeout reached after $TimeoutSeconds seconds. Terminating process PID $($p.Id)..."
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        # Wait briefly to allow termination
        Start-Sleep -Milliseconds 200
        Write-Host "Process terminated due to timeout."
        $ExitCode = 0 # Treat timeout as success for the smoke test purpose
    }
} catch {
    Write-Error "An error occurred while waiting for or stopping the process: $($_.Exception.Message)"
    # Ensure process is killed if script errored during wait/stop
    if ($p -ne $null -and !$p.HasExited) {
        Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    }
    $ExitCode = 1 # Ensure failure code
}

# Final check based on exit code
if ($ExitCode -eq 0) {
    Write-Host "✅ Smoke test passed."
    exit 0
} else {
    Write-Host "❌ Smoke test failed (Exit Code: $ExitCode)."
    exit $ExitCode
} 