param(
    [ValidatePattern('^http://(127\.0\.0\.1|localhost):\d+/?$')][string]$BaseUrl = 'http://127.0.0.1:5020',
    [ValidatePattern('^[a-z0-9-]+$')][string]$BrowserSession = 'xpeed-3d-review'
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$captureCode = @'
(async () => {
 if (!customElements.get('model-viewer')) throw new Error('First open Home with a matching model in the local browser session');
 const response=await fetch('/api/vehicle-visuals');
 if(!response.ok) throw new Error('Start the local harness with the development catalog');
 const catalog=(await response.json()).visuals;
 const posters=[];
 for(const visual of catalog) {
  const model=document.createElement('model-viewer');
  Object.assign(model.style,{position:'fixed',top:'0',left:'0',width:'640px',height:'480px',zIndex:'99999',backgroundColor:'transparent'});
  model.setAttribute('camera-orbit','145deg 75deg 100%');model.setAttribute('shadow-intensity','0.7');model.setAttribute('loading','eager');
  const loaded=new Promise((resolve,reject)=> {model.addEventListener('load',resolve,{once:true});model.addEventListener('error',()=>reject(new Error(visual.key)),{once:true});});
  model.src=visual.modelPath; document.body.append(model); await loaded; await model.updateComplete;
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  const blob=await model.toBlob({mimeType:'image/png',idealAspect:true});
  const data=await new Promise(resolve=>{const r=new FileReader();r.onload=()=>resolve(r.result.split(',')[1]);r.readAsDataURL(blob);});
  posters.push({key:visual.key,data});model.remove();
 }
 return posters;
})()
'@
    $currentUrl = agent-browser --session $BrowserSession get url
    if (([Uri]$currentUrl).GetLeftPart([UriPartial]::Authority) -ne $BaseUrl.TrimEnd('/')) { throw 'Browser must show the local harness URL' }
    $captureResult = (agent-browser --session $BrowserSession --json eval $captureCode) | ConvertFrom-Json
    if (-not $captureResult.success) { throw $captureResult.error }
    foreach ($poster in $captureResult.data.result) {
        if ($poster.key -notmatch '^[a-z0-9-]+$') { throw 'Invalid poster name' }
        $targetPath = Join-Path $projectRoot "public/vehicle-visuals/$($poster.key).png"
        [IO.File]::WriteAllBytes($targetPath, [Convert]::FromBase64String($poster.data))
        Write-Output "Rendered transparent poster: $($poster.key)"
    }
