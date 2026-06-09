Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('C:\Users\User\Downloads\photostrip.png')
$pd = New-Object System.Drawing.Printing.PrintDocument
$pd.PrinterSettings.PrinterName = "Canon SELPHY CP1300 WS"
$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
$target = $pd.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -like '*P borderless 4x6*' } | Select-Object -First 1
$pd.DefaultPageSettings.PaperSize = $target
$script:imgRef = $img
$area = $pd.DefaultPageSettings.PrintableArea
$script:pw = [int]($area.Width / 100.0 * 300)
$script:ph = [int]($area.Height / 100.0 * 300)
$scale = [Math]::Min($script:pw / $img.Width, $script:ph / $img.Height)
$script:drawW = [int]($img.Width * $scale)
$script:drawH = [int]($img.Height * $scale)
$script:drawX = [int](($script:pw - $script:drawW) / 2)
$script:drawY = [int](($script:ph - $script:drawH) / 2)
$pd.Add_PrintPage({ param($s,$e)
    $e.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Pixel
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $e.Graphics.DrawImage($script:imgRef, $script:drawX, $script:drawY, $script:drawW, $script:drawH)
    $e.HasMorePages = $false
})
$pd.Print()
$img.Dispose()
Write-Host "Done"