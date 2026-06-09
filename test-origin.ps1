Add-Type -AssemblyName System.Drawing

$printerName = "Canon SELPHY CP1300 WS"

$pd = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = $printerName
$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)

$target = $pd.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -like '*borderless 4x6*' } | Select-Object -First 1
if (-not $target) { $target = $pd.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -like '*borderless*' } | Select-Object -First 1 }
$pd.DefaultPageSettings.PaperSize = $target
Write-Host "Paper: $($target.PaperName)"

$area = $pd.DefaultPageSettings.PrintableArea
Write-Host "PrintableArea: X=$($area.X) Y=$($area.Y) W=$($area.Width) H=$($area.Height)"

$pd.Add_PrintPage({
    param($s, $e)

    # Test 1: PageUnit Pixel — draw red rect at (0,0)
    $e.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Pixel
    $dpiX = $e.Graphics.DpiX
    $dpiY = $e.Graphics.DpiY
    Write-Host "DPI: $dpiX x $dpiY"

    $paperW = [int]($s.DefaultPageSettings.PaperSize.Width  / 100.0 * $dpiX)
    $paperH = [int]($s.DefaultPageSettings.PaperSize.Height / 100.0 * $dpiY)
    $areaX  = [int]($e.PageSettings.PrintableArea.X / 100.0 * $dpiX)
    $areaY  = [int]($e.PageSettings.PrintableArea.Y / 100.0 * $dpiY)
    $areaW  = [int]($e.PageSettings.PrintableArea.Width  / 100.0 * $dpiX)
    $areaH  = [int]($e.PageSettings.PrintableArea.Height / 100.0 * $dpiY)
    Write-Host "Paper px: $paperW x $paperH"
    Write-Host "Area offset px: $areaX, $areaY"

    # Fill whole printable area white
    $e.Graphics.FillRectangle([System.Drawing.Brushes]::White, 0, 0, $areaW, $areaH)

    # Red border 10px inside printable area (0,0)
    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::Red, 6)
    $e.Graphics.DrawRectangle($pen, 5, 5, $areaW-10, $areaH-10)

    # Blue cross at exact center of printable area
    $cx = [int]($areaW / 2)
    $cy = [int]($areaH / 2)
    $bluePen = New-Object System.Drawing.Pen([System.Drawing.Color]::Blue, 4)
    $e.Graphics.DrawLine($bluePen, $cx-40, $cy, $cx+40, $cy)
    $e.Graphics.DrawLine($bluePen, $cx, $cy-40, $cx, $cy+40)

    # Green dot at (0,0) — top-left of printable area
    $e.Graphics.FillEllipse([System.Drawing.Brushes]::Green, 0, 0, 30, 30)

    # Black text showing offsets
    $font = New-Object System.Drawing.Font("Arial", 14)
    $e.Graphics.DrawString("Area offset: $areaX, $areaY px", $font, [System.Drawing.Brushes]::Black, 10, 50)
    $e.Graphics.DrawString("Paper: $paperW x $paperH px", $font, [System.Drawing.Brushes]::Black, 10, 80)
    $e.Graphics.DrawString("Area: $areaW x $areaH px", $font, [System.Drawing.Brushes]::Black, 10, 110)

    $pen.Dispose(); $bluePen.Dispose(); $font.Dispose()
    $e.HasMorePages = $false
})

$pd.Print()
Write-Host "Printed test page"
$pd.Dispose()