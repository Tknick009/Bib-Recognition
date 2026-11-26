<#
Bib Timer -> RunScore

Runs on the scoring computer, next to RunScore. It fetches each new result
from the Bib Timer results hub and writes it to the TCP port RunScore listens
on, as one line of RunScore's Open Interface:

    RSBI,<bib>,<time>,<location>        for example  RSBI,214,10:23:45.67,Finish A

It keeps going until the window is closed or Ctrl+C is pressed. If RunScore or
the internet connection goes away, it waits and then carries on where it
stopped. What it has passed on is remembered on this computer, so stopping and
starting it again neither skips a result nor passes one on twice.

A result is passed on a few seconds after it was recorded (-Settle), which
gives the camera time to correct a number while the bib is still in view. If a
result is corrected or deleted on the iPad after it was passed on, this window
says so: RunScore cannot be asked to take a result back, so that is for the
operator to do.

Typical use (the results page writes this line out for you):

    powershell -ExecutionPolicy Bypass -File runscore.ps1 -Hub https://my-results.up.railway.app -Key my-key -EventCode spring-run-20261128 -RunScorePort 3988

To check the connection to RunScore beforehand, with one made-up result:

    powershell -ExecutionPolicy Bypass -File runscore.ps1 -Test -RunScorePort 3988

This file is plain ASCII on purpose, and works with the Windows PowerShell
that comes with Windows as well as with PowerShell 7.
#>
[CmdletBinding()]
param(
    # Address of the results hub, e.g. https://my-results.up.railway.app
    [string] $Hub = '',
    # The hub's access key (the view key is enough). Asked for if left out.
    [string] $Key = '',
    # The event code, as shown on the results page and in Race setup on the iPads.
    [string] $EventCode = '',
    # Where RunScore listens. 127.0.0.1 is this computer.
    [string] $RunScoreHost = '127.0.0.1',
    [ValidateRange(1, 65535)] [int] $RunScorePort = 3988,
    # Only results from these iPads (device identifiers, separated by commas). Empty: all.
    [string] $Devices = '',
    # The location name written on every line. Empty: the name of the iPad's station.
    [string] $Location = '',
    # Seconds a result must have been left unchanged before it is passed on.
    [ValidateRange(0, 300)] [int] $Settle = 8,
    # Digits after the seconds, 0 to 3.
    [ValidateRange(0, 3)] [int] $Decimals = 2,
    # RSBI for bib numbers; RunScore also knows RSCI for chip codes.
    [ValidatePattern('^[A-Za-z]{1,10}$')] [string] $Prefix = 'RSBI',
    # day: time of day. elapsed: time since the start set on an iPad.
    [ValidateSet('day', 'elapsed')] [string] $Time = 'day',
    [ValidateSet('CRLF', 'LF', 'CR')] [string] $LineEnding = 'CRLF',
    # Where the record of what has been passed on is kept.
    [string] $StateFolder = '',
    # Forget what has been passed on and pass everything on again.
    [switch] $ResendAll,
    # Send one made-up result to RunScore and stop.
    [switch] $Test,
    [string] $TestBib = '9999',
    # Longest time, in seconds, to let the hub hold a request while there is nothing new.
    [ValidateRange(0, 25)] [int] $Wait = 20
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Older Windows versions do not offer TLS 1.2 unless asked to.
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

function Say([string] $text, [string] $color = '') {
    $stamp = (Get-Date).ToString('HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
    if ($color -ne '') {
        Write-Host ('{0}  {1}' -f $stamp, $text) -ForegroundColor $color
    } else {
        Write-Host ('{0}  {1}' -f $stamp, $text)
    }
}

# In the classic console window a click selects text, and while text is
# selected Windows holds up the program that owns the window, until Enter is
# pressed. A stray click must not stop results on their way to RunScore, so
# that way of selecting is switched off for this window.
$window = @{ Console = $null; Input = $null; Before = $null }

function Disable-ClickToSelect {
    if ($env:OS -ne 'Windows_NT') { return }
    try {
        $functions = '[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int which);' +
            '[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);' +
            '[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr handle, uint mode);'
        $console = Add-Type -MemberDefinition $functions -Name 'ConsoleWindow' -Namespace 'BibTimer' -PassThru
        $keyboardAndMouse = $console::GetStdHandle(-10)
        [uint32] $mode = 0
        if ($console::GetConsoleMode($keyboardAndMouse, [ref] $mode)) {
            # Without "quick edit" (0x40); 0x80 says that this choice is meant.
            $wanted = [uint32] ((([long] $mode) -band (-bnot ([long] 0x40))) -bor 0x80)
            if ($console::SetConsoleMode($keyboardAndMouse, $wanted)) {
                $window.Console = $console
                $window.Input = $keyboardAndMouse
                $window.Before = $mode
            }
        }
    } catch { }
}

# Puts the window back the way it was, for whatever it is used for next.
function Restore-ClickToSelect {
    try {
        if ($null -ne $window.Before) {
            $null = $window.Console::SetConsoleMode($window.Input, [uint32] $window.Before)
            $window.Before = $null
        }
    } catch { }
}

# ---- The connection to RunScore ----

# Kept in one object, so that the functions below change the same thing
# wherever they are called from.
$link = @{ Client = $null; Stream = $null }
$endings = @{ CRLF = "`r`n"; LF = "`n"; CR = "`r" }
$ending = $endings[$LineEnding]
$utf8 = New-Object System.Text.UTF8Encoding($false)
$runScoreAt = '{0}:{1}' -f $RunScoreHost, $RunScorePort

function Close-RunScore {
    if ($link.Client) {
        try { $link.Client.Close() } catch { }
    }
    $link.Client = $null
    $link.Stream = $null
}

# True if a connection to RunScore is open afterwards.
function Open-RunScore {
    if ($link.Client) { return $true }
    $attempt = New-Object System.Net.Sockets.TcpClient
    try {
        $pending = $attempt.BeginConnect($RunScoreHost, $RunScorePort, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(3000)) { throw 'no answer' }
        $attempt.EndConnect($pending)
        $attempt.NoDelay = $true
        $link.Client = $attempt
        $link.Stream = $attempt.GetStream()
        return $true
    } catch {
        try { $attempt.Close() } catch { }
        return $false
    }
}

# False once RunScore has closed the connection. Anything RunScore sends back
# is read and dropped, so that it cannot pile up.
function Test-RunScore {
    if (-not $link.Client) { return $false }
    try {
        $socket = $link.Client.Client
        while ($socket.Available -gt 0) {
            $unused = New-Object byte[] 4096
            $null = $link.Stream.Read($unused, 0, $unused.Length)
        }
        if ($socket.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $socket.Available -eq 0) { return $false }
        return [bool] $socket.Connected
    } catch {
        return $false
    }
}

function Send-Line([string] $text) {
    $bytes = $utf8.GetBytes($text + $ending)
    $link.Stream.Write($bytes, 0, $bytes.Length)
    $link.Stream.Flush()
}

# ---- Checking the connection with a made-up result ----

if ($Test) {
    if (-not (Open-RunScore)) {
        Say ('Nothing is listening at {0}. In RunScore, set up the timer input for TCP on this port and start it, then try again.' -f $runScoreAt) 'Red'
        return
    }
    # Written the same way whatever language and region Windows is set to.
    $stamp = (Get-Date).ToString('HH:mm:ss.fff', [System.Globalization.CultureInfo]::InvariantCulture)
    $stamp = $stamp.Substring(0, 8 + $(if ($Decimals -gt 0) { $Decimals + 1 } else { 0 }))
    $where = $(if ($Location -ne '') { $Location } else { 'TEST' })
    $line = '{0},{1},{2},{3}' -f $Prefix.ToUpper(), $TestBib, $stamp, $where
    try {
        Send-Line $line
        Start-Sleep -Milliseconds 300
        if (Test-RunScore) {
            Say ('Sent to RunScore at {0}:  {1}' -f $runScoreAt, $line) 'Green'
            Say 'Look for it in RunScore. If it is not there, RunScore is listening but did not understand the line.'
        } else {
            Say ('RunScore at {0} closed the connection when the line was sent.' -f $runScoreAt) 'Red'
        }
    } catch {
        Say ('The line could not be sent to {0}: {1}' -f $runScoreAt, $_.Exception.Message) 'Red'
    }
    Close-RunScore
    return
}

# ---- Settings ----

$Hub = $Hub.Trim().TrimEnd('/')
if ($Hub -eq '' -or $EventCode -eq '') {
    Say 'Give the address of the results hub (-Hub) and the event code (-EventCode).' 'Red'
    return
}
if ($Hub -notmatch '^https?://') { $Hub = 'https://' + $Hub }
if ($Hub -match '^http://' -and $Hub -notmatch '^http://(localhost|127\.0\.0\.1)(:|/|$)') {
    Say 'Warning: this address is not encrypted (http), so the access key travels in the open. Use https.' 'Yellow'
}
if ($Key -eq '') {
    $typed = Read-Host -Prompt 'Access key of the results hub' -AsSecureString
    $Key = (New-Object System.Net.NetworkCredential('', $typed)).Password
}
$headers = @{ Authorization = ('Bearer {0}' -f $Key) }

if ($StateFolder -eq '') {
    if ($env:LOCALAPPDATA) {
        $StateFolder = Join-Path $env:LOCALAPPDATA 'BibTimer'
    } else {
        $StateFolder = Join-Path $HOME '.bibtimer'
    }
}
$null = New-Item -ItemType Directory -Force -Path $StateFolder
$StateFolder = (Resolve-Path -LiteralPath $StateFolder).ProviderPath
$name = ('runscore-{0}-{1}-{2}' -f $EventCode, $RunScoreHost, $RunScorePort) -replace '[^A-Za-z0-9.-]', '_'
$placeFile = Join-Path $StateFolder ($name + '.json')
$sentFile = Join-Path $StateFolder ($name + '.sent.txt')

# ---- What has been passed on already ----

# Every line that has gone to RunScore, so that none goes twice even if the
# hub starts its list over. Where the reading of the hub's list has got to.
$sent = New-Object 'System.Collections.Generic.HashSet[string]'
$place = @{ Feed = ''; After = [long] 0 }

if ($ResendAll) {
    foreach ($file in @($placeFile, $sentFile)) {
        if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    }
} else {
    if (Test-Path -LiteralPath $sentFile) {
        foreach ($old in [System.IO.File]::ReadAllLines($sentFile)) {
            if ($old -ne '') { $null = $sent.Add($old) }
        }
    }
    if (Test-Path -LiteralPath $placeFile) {
        try {
            $saved = [System.IO.File]::ReadAllText($placeFile) | ConvertFrom-Json
            if ($saved.feed) {
                $place.Feed = [string] $saved.feed
                $place.After = [long] $saved.after
            }
        } catch {
            Say 'The note of where it had got to could not be read. Starting from the first result; nothing is passed on twice.' 'Yellow'
        }
    }
}

# The two files below are bookkeeping. Trouble with them (a full disk, a
# virus scanner holding a file) is reported, but must never stop results from
# being passed on: while this window stays open, what it has passed on is
# also remembered here in memory.
function Save-Place {
    try {
        $text = @{ feed = $place.Feed; after = $place.After } | ConvertTo-Json -Compress
        [System.IO.File]::WriteAllText($placeFile, $text)
    } catch {
        Say ('Could not note where it has got to ({0}). It carries on.' -f $_.Exception.Message) 'Yellow'
    }
}

function Add-ToRecord($lines) {
    try {
        [System.IO.File]::AppendAllText($sentFile, (($lines -join "`r`n") + "`r`n"))
    } catch {
        Say ('Could not add to the record of what was passed on ({0}). It carries on.' -f $_.Exception.Message) 'Yellow'
    }
}

# ---- Talking to the hub ----

function Get-Feed {
    $parts = @($place.After, [uri]::EscapeDataString($place.Feed), $Wait, $Settle, $Decimals, [uri]::EscapeDataString($Prefix), $Time)
    $query = 'after={0}&feed={1}&wait={2}&settle={3}&decimals={4}&prefix={5}&time={6}' -f $parts
    if ($Devices -ne '') { $query += '&devices=' + [uri]::EscapeDataString($Devices) }
    if ($Location -ne '') { $query += '&location=' + [uri]::EscapeDataString($Location) }
    $address = '{0}/api/events/{1}/runscore?{2}' -f $Hub, [uri]::EscapeDataString($EventCode), $query
    return Invoke-RestMethod -Uri $address -Headers $headers -TimeoutSec ($Wait + 30) -UseBasicParsing
}

# What went wrong with a request to the hub: the status it answered with (0 if
# it did not answer at all) and its explanation, if it gave one.
function Read-Failure($failure) {
    $status = 0
    $said = ''
    try {
        $response = $failure.Exception.Response
        if ($response) { $status = [int] $response.StatusCode }
    } catch { }
    try {
        if ($failure.ErrorDetails -and $failure.ErrorDetails.Message) {
            $said = [string] (($failure.ErrorDetails.Message | ConvertFrom-Json).error)
        }
    } catch { }
    if ($said -eq '' -and $status -eq 0) { $said = [string] $failure.Exception.Message }
    return @{ Status = $status; Said = $said }
}

function Explain-Failure($problem) {
    if ($problem.Status -eq 401) { return 'The hub did not accept the access key. Check -Key.' }
    if ($problem.Status -eq 404) { return ('The hub has no event "{0}" yet. It appears when an iPad first sends results; check the event code if it does not.' -f $EventCode) }
    if ($problem.Status -eq 0) { return ('The hub cannot be reached ({0}).' -f $problem.Said) }
    if ($problem.Said -ne '') { return $problem.Said }
    return ('The hub answered with error {0}.' -f $problem.Status)
}

# ---- Start ----

Disable-ClickToSelect
Say 'Bib Timer -> RunScore'
Say ('Results of "{0}" from {1} go to RunScore at {2}.' -f $EventCode, $Hub, $runScoreAt)
Say ('Passed on before: {0}. The record is kept in {1}' -f $sent.Count, $sentFile)
Say 'Leave this window open. If it ever seems stuck, click in it and press Enter.'

try {
    $ping = Invoke-RestMethod -Uri ($Hub + '/api/ping') -Headers $headers -TimeoutSec 20 -UseBasicParsing
    if ($ping.ok) { Say 'The hub accepts the key.' 'Green' }
} catch {
    Say (Explain-Failure (Read-Failure $_)) 'Red'
    Say 'It will keep trying.'
}

$waitingForRunScore = $false
$trouble = ''
$failures = 0
# Notes shown already, so that one is not repeated: when a batch is sent
# again, or when the same thing holds for result after result.
$told = New-Object 'System.Collections.Generic.HashSet[string]'

try {
    while ($true) {
      try {
        # RunScore first: without it there is nowhere to put a result.
        if (-not (Test-RunScore)) {
            if ($link.Client) {
                Close-RunScore
                Say 'RunScore has closed the connection.' 'Yellow'
            }
            if (-not (Open-RunScore)) {
                if (-not $waitingForRunScore) {
                    Say ('Waiting for RunScore to listen at {0} ...' -f $runScoreAt) 'Yellow'
                    $waitingForRunScore = $true
                }
                Start-Sleep -Seconds 2
                continue
            }
            $waitingForRunScore = $false
            Say ('Connected to RunScore at {0}.' -f $runScoreAt) 'Green'
        }

        # The hub holds this request until there is something new, or for
        # -Wait seconds, so asking again at once does not waste data.
        $asked = Get-Date
        $reply = $null
        try {
            $reply = Get-Feed
        } catch {
            $problem = Read-Failure $_
            $message = Explain-Failure $problem
            if ($message -ne $trouble) {
                Say $message 'Red'
                $trouble = $message
            }
            $failures += 1
            if ($problem.Status -eq 401 -or $problem.Status -eq 409) {
                $pause = 30
            } elseif ($problem.Status -eq 404) {
                $pause = 5
            } else {
                $pause = [Math]::Min(30, [Math]::Pow(2, [Math]::Min($failures, 5)))
            }
            Start-Sleep -Seconds $pause
            continue
        }
        if ($null -eq $reply -or -not $reply.feed) {
            # Something answered, but not the hub (a sign-in page of the network, say).
            $message = 'The answer did not come from the results hub. Check the address and the network.'
            if ($message -ne $trouble) {
                Say $message 'Red'
                $trouble = $message
            }
            Start-Sleep -Seconds 5
            continue
        }
        if ($trouble -ne '') {
            Say 'The hub answers again.' 'Green'
            $trouble = ''
        }
        $failures = 0

        $entries = @($reply.entries)
        $written = New-Object 'System.Collections.Generic.List[string]'
        $delivered = $true
        foreach ($entry in $entries) {
            if ($entry.note -and $told.Add([string] $entry.note)) {
                Say ('NOTE  {0}' -f $entry.note) 'Yellow'
            }
            if (-not $entry.line) { continue }
            $line = [string] $entry.line
            if ($sent.Contains($line) -or $written.Contains($line)) { continue }
            if (-not (Test-RunScore)) {
                $delivered = $false
                break
            }
            try {
                Send-Line $line
            } catch {
                $delivered = $false
                break
            }
            $written.Add($line)
        }
        if ($delivered -and $written.Count -gt 0) {
            # If RunScore has gone away, that shows a moment after writing to it.
            Start-Sleep -Milliseconds 200
            if (-not (Test-RunScore)) { $delivered = $false }
        }
        if (-not $delivered) {
            Close-RunScore
            Say 'RunScore went away while results were on their way to it. They will be passed on again when it is back.' 'Yellow'
            continue
        }

        if ($written.Count -gt 0) {
            foreach ($line in $written) { $null = $sent.Add($line) }
            Add-ToRecord $written
            foreach ($line in $written) { Say ('-> {0}' -f $line) }
        }
        if (([string] $reply.feed) -ne $place.Feed -or ([long] $reply.next) -ne $place.After) {
            $place.Feed = [string] $reply.feed
            $place.After = [long] $reply.next
            Save-Place
        }

        # A hub that answers at once with nothing is not holding requests:
        # then this asks every two seconds instead of in a tight loop.
        if ($entries.Count -eq 0 -and ((Get-Date) - $asked).TotalMilliseconds -lt 1000) {
            Start-Sleep -Milliseconds 2000
        }
      } catch {
        # Whatever went wrong in this round, the next one starts afresh.
        Say ('Something unexpected happened ({0}). It carries on.' -f $_.Exception.Message) 'Red'
        Close-RunScore
        Start-Sleep -Seconds 2
      }
    }
} finally {
    Close-RunScore
    Restore-ClickToSelect
}
