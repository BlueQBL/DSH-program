# 解码 Oracle DUMP(col,1016) 输出的 UTF-8 十六进制，还原中文。
# 支持格式：e5,85,a8 / e5 85 a8 / e585a8，可带 "Typ=1 Len=27 CharacterSet=AL32UTF8:" 前缀，可含 NULL 行。
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Hex,
    [string]$Label = ''
)

$bytes = New-Object System.Collections.Generic.List[byte]
foreach ($line in ($Hex -split "`r?`n")) {
    $t = $line.Trim()
    if ($t -eq '') { continue }
    $t = $t -replace '^.*AL32UTF8:\s*', ''
    if ($t -match '^\s*NULL\s*$') { Write-Output "$Label`tNULL"; continue }
    $t = $t -replace '[^0-9A-Fa-f]', ''
    if ($t.Length % 2 -ne 0) { Write-Output "$Label`tERR(odd-hex:$($t.Length))"; continue }
    for ($i = 0; $i -lt $t.Length; $i += 2) {
        $bytes.Add([Convert]::ToByte($t.Substring($i, 2), 16))
    }
}

if ($bytes.Count -gt 0) {
    $s = [System.Text.Encoding]::UTF8.GetString($bytes.ToArray())
    Write-Output "$Label`t$s"
}
