  // Pan/zoom canvas with click-vs-drag detection

let settings = {};

async function fetchJSON() {
  const res = await fetch('ServerSettings.json');
  if (!res.ok) throw new Error('Failed to load ServerSettings.json: ' + res.status);
  settings = await res.json();
  console.log('Loaded ServerSettings.json:', settings);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = (e) => {
      console.error('Image load error for', src, e);
      reject(new Error('Image load error: ' + src));
    };
    img.src = src;
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  try {
    await fetchJSON();
  } catch (err) {
    console.error('Could not load ServerSettings.json', err);
    return;
  }

  const canvas = document.getElementById('mapCanvas');
  if (!canvas) {
    console.error('mapCanvas element not found');
    return;
  }
  const ctx = canvas.getContext('2d');
  

  // --- Move state declarations up so draw() is safe to call ---
  let img = null;               // will be set after load
  let panX = 0, panY = 0;
  let scale = 1;
  let dpr = window.devicePixelRatio || 1;
  const minScale = 0.1, maxScale = 50;

  // temporary pending claims (accessible to draw)
  const pendingClaims = [];
  // debug markers for nearby seed picks
  const debugSeeds = [];
  const overlayComposites = []; // transient canvas pieces to draw into main ctx (so fills are visible)

  // claimRegion placeholder; assigned after image loads
  let claimRegion = (imgX, imgY) => {
    console.log('claimRegion called before image load — ignoring', imgX, imgY);
  };

  function draw() {
    if (!ctx) return;
    if (!img) {
      // image not ready yet; nothing to draw
      return;
    }
    // clear in device-pixel coordinates
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,canvas.width,canvas.height);

    // disable smoothing so pixels stay crisp when scaled
    ctx.imageSmoothingEnabled = false;
    try { ctx.imageSmoothingQuality = 'low'; } catch (e) {}

    // Calculate dest rect - ensure pixel alignment by rounding coordinates
    const destX = Math.round(panX * dpr);
    const destY = Math.round(panY * dpr);
    const destW = Math.round(img.width * scale * dpr);
    const destH = Math.round(img.height * scale * dpr);

    // draw base image first (device-pixel coords)
    ctx.setTransform(1,0,0,1,0,0);
    ctx.drawImage(img, 0, 0, img.width, img.height, destX, destY, destW, destH);

    // draw overlays on TOP using identical dest rect for pixel-perfect alignment
    try {
      ctx.setTransform(1,0,0,1,0,0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      if (typeof savedOverlay !== 'undefined') ctx.drawImage(savedOverlay, 0, 0, img.width, img.height, destX, destY, destW, destH);
      if (typeof tempOverlay !== 'undefined') ctx.drawImage(tempOverlay, 0, 0, img.width, img.height, destX, destY, destW, destH);

      // draw transient overlay composites
      overlayComposites.forEach(o => {
        try {
          const sx = o.minX, sy = o.minY, sw = o.canvas.width, sh = o.canvas.height;
          const dx = sx * scale * dpr + destX;
          const dy = sy * scale * dpr + destY;
          const dw = sw * scale * dpr;
          const dh = sh * scale * dpr;
          ctx.drawImage(o.canvas, 0, 0, sw, sh, dx, dy, dw, dh);
        } catch (e) {
          /* ignore */
        }
      });
      // Note: overlayComposites cleared when overlays are reloaded
    } finally {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // helper to map image coords to canvas pixels
    function imgToCanvasX(x) { return x * dpr * scale + panX * dpr; }
    function imgToCanvasY(y) { return y * dpr * scale + panY * dpr; }

    // reset transform
    ctx.setTransform(1,0,0,1,0,0);
  }

  function resizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    // Size the backing store in device pixels so rendering stays sharp on high-DPI displays
    canvas.width = Math.ceil(canvas.clientWidth * dpr);
    canvas.height = Math.ceil(canvas.clientHeight * dpr);
    draw(); // safe — draw checks for img and will return if not loaded yet
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Populate team dropdown and swatch from settings
  const teamSelect = document.getElementById('teamSelect');
  const teamSwatch = document.getElementById('teamSwatch');
  let selectedTeam = null;

  function updateSwatch(teamName) {
    if (!teamSwatch) return;
    if (teamName === '__EMPTY__') {
      teamSwatch.style.backgroundColor = '#ffffff';
      teamSwatch.title = 'Remove claims';
    } else {
      const color = settings.Teams && settings.Teams[teamName] && settings.Teams[teamName].color;
      teamSwatch.style.backgroundColor = color || 'transparent';
      teamSwatch.title = teamName ? `${teamName} (${color})` : '';
    }
  }

  if (teamSelect && settings.Teams && Object.keys(settings.Teams).length) {
    teamSelect.innerHTML = '';
    const names = Object.keys(settings.Teams);
    // Add "Empty" option at the beginning for removing claims
    const emptyOpt = document.createElement('option');
    emptyOpt.value = '__EMPTY__';
    emptyOpt.textContent = 'Remove Claim';
    teamSelect.appendChild(emptyOpt);
    
    names.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      teamSelect.appendChild(opt);
    });
    selectedTeam = '__EMPTY__';
    teamSelect.value = selectedTeam;
    updateSwatch(selectedTeam);
    teamSelect.addEventListener('change', (e) => {
      selectedTeam = e.target.value;
      updateSwatch(selectedTeam);
    });
  } else {
    if (teamSelect) teamSelect.style.display = 'none';
    if (teamSwatch) teamSwatch.style.display = 'none';
  }

  function getSelectedTeamColor() {
    if (selectedTeam === '__EMPTY__') return '#ffffff'; // white for remove
    return settings.Teams && settings.Teams[selectedTeam] && settings.Teams[selectedTeam].color;
  }

  // ----- load the image (same as before) -----
  if (!settings.mapImage) {
    console.warn('mapImage not set in ServerSettings.json');
    return;
  }

  try {
    img = await loadImage(settings.mapImage);
    
    // Fit map to viewport: calculate scale to fit entire image
    const canvasRect = canvas.getBoundingClientRect();
    const scaleX = canvasRect.width / img.width;
    const scaleY = canvasRect.height / img.height;
    scale = Math.min(scaleX, scaleY, 1); // don't scale up, max 1:1
    
    // Center the image
    panX = (canvasRect.width - img.width * scale) / 2;
    panY = (canvasRect.height - img.height * scale) / 2;
    
    // create offscreen canvas at image natural size for pixel sampling and exact pixels
    const offscreen = document.createElement('canvas');
    offscreen.width = img.width;
    offscreen.height = img.height;
    const offCtx = offscreen.getContext('2d');
    offCtx.imageSmoothingEnabled = false;
    offCtx.drawImage(img, 0, 0);

    // cache base image data for fast pixel queries (used for flood fill boundary tests)
    const baseImageData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    const baseData = baseImageData.data;

    // create overlay canvases (saved fills and temporary fills)
    const savedOverlay = document.createElement('canvas');
    savedOverlay.width = offscreen.width;
    savedOverlay.height = offscreen.height;
    const savedCtx = savedOverlay.getContext('2d');
    savedCtx.imageSmoothingEnabled = false;

    const tempOverlay = document.createElement('canvas');
    tempOverlay.width = offscreen.width;
    tempOverlay.height = offscreen.height;
    const tempCtx = tempOverlay.getContext('2d');
    tempCtx.imageSmoothingEnabled = false;

    // Cache claim IDs to avoid redundant flood fills
    const renderedClaimIds = new Set();

    function updatePendingCount() {
      const el = document.getElementById('pendingCount');
      if (!el) return;
      el.textContent = pendingClaims.length ? `Pending: ${pendingClaims.length}` : '';
    }

    // helpers
    function hexToRgba(hex, alpha = 255) {
      if (!hex) return [0,0,0,alpha];
      const m = hex.replace('#','');
      const bigint = parseInt(m.length===3? m.split('').map(c=>c+c).join(''): m, 16);
      const r = (bigint >> 16) & 255;
      const g = (bigint >> 8) & 255;
      const b = bigint & 255;
      return [r,g,b,alpha];
    }

    function isBaseWhiteXY(x, y) {
      if (x < 0 || y < 0 || x >= offscreen.width || y >= offscreen.height) return false;
      const idx = (y * offscreen.width + x) * 4;
      const r = baseData[idx];
      const g = baseData[idx + 1];
      const b = baseData[idx + 2];
      // check for white pixels (RGB 255,255,255)
      return r === 255 && g === 255 && b === 255;
    }

    function sampleBaseRGBA(x, y) {
      if (x < 0 || y < 0 || x >= offscreen.width || y >= offscreen.height) return null;
      const idx = (y * offscreen.width + x) * 4;
      return { r: baseData[idx], g: baseData[idx+1], b: baseData[idx+2], a: baseData[idx+3] };
    }

    // BFS search for nearest white pixel within maxRadius (returns {x,y} or null)
    function findNearestWhitePixel(sx, sy, maxRadius = 50) {
      const w = offscreen.width, h = offscreen.height;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
      const maxDist2 = maxRadius * maxRadius;
      const visited = new Uint8Array(w * h);
      const q = [];
      q.push({ x: sx, y: sy });
      visited[sy * w + sx] = 1;
      let head = 0;
      while (head < q.length) {
        const p = q[head++];
        const dx = p.x - sx, dy = p.y - sy;
        if (dx*dx + dy*dy > maxDist2) continue;
        if (isBaseWhiteXY(p.x, p.y)) return p;
        // push neighbors (4-neighborhood)
        const neighbors = [ {x:p.x, y:p.y-1}, {x:p.x, y:p.y+1}, {x:p.x-1, y:p.y}, {x:p.x+1, y:p.y} ];
        for (const n of neighbors) {
          if (n.x < 0 || n.y < 0 || n.x >= w || n.y >= h) continue;
          const idx = n.y * w + n.x;
          if (visited[idx]) continue;
          visited[idx] = 1;
          q.push(n);
        }
      }
      return null;
    }

    // flood fill overlay ctx starting at img coords using scanline algorithm (correct implementation)
    function floodFillOverlay(overlayCtx, startX, startY, fillRGBA) {
      const w = offscreen.width, h = offscreen.height;
      let sx = Math.floor(startX), sy = Math.floor(startY);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) return false;
      if (!isBaseWhiteXY(sx, sy)) return false;

      let imgData;
      try {
        imgData = overlayCtx.getImageData(0, 0, w, h);
      } catch (e) {
        console.error('floodFillOverlay: getImageData failed (canvas tainted?):', e);
        return false;
      }
      const data = imgData.data;

      const getIndex = (x, y) => (y * w + x) * 4;
      const pixelHasFill = (idx) => data[idx + 3] !== 0; // alpha != 0 means already filled

      const stack = [{ x: sx, y: sy }];
      let filledCount = 0;
      const visited = new Uint8Array(w * h);
      let minX = w, minY = h, maxX = -1, maxY = -1;

      while (stack.length) {
        const p = stack.pop();
        let x = p.x;
        let y = p.y;

        // skip if already visited or not white
        if (visited[y * w + x] || !isBaseWhiteXY(x, y)) continue;

        // move to leftmost pixel of this span
        while (x > 0 && isBaseWhiteXY(x - 1, y) && !pixelHasFill(getIndex(x - 1, y)) && !visited[y * w + (x - 1)]) x--;
        
        // fill rightward from x
        let i = x;
        while (i < w && isBaseWhiteXY(i, y) && !pixelHasFill(getIndex(i, y)) && !visited[y * w + i]) {
          const idx = getIndex(i, y);
          data[idx] = fillRGBA[0];
          data[idx + 1] = fillRGBA[1];
          data[idx + 2] = fillRGBA[2];
          data[idx + 3] = fillRGBA[3];
          visited[y * w + i] = 1;
          filledCount++;
          if (i < minX) minX = i;
          if (i > maxX) maxX = i;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          
          i++;
        }
        const x2 = i - 1;

        // check the line above and below for new spans
        for (let j = x; j <= x2; j++) {
          // above
          if (y > 0 && isBaseWhiteXY(j, y - 1) && !pixelHasFill(getIndex(j, y - 1)) && !visited[(y - 1) * w + j]) {
            stack.push({ x: j, y: y - 1 });
          }
          // below
          if (y < h - 1 && isBaseWhiteXY(j, y + 1) && !pixelHasFill(getIndex(j, y + 1)) && !visited[(y + 1) * w + j]) {
            stack.push({ x: j, y: y + 1 });
          }
        }
      }

      if (filledCount === 0) return false;
      
      overlayCtx.putImageData(imgData, 0, 0);

      // create a small transient canvas for the filled region and store it so draw() can composite it visibly
      try {
        const regionW = Math.max(1, maxX - minX + 1);
        const regionH = Math.max(1, maxY - minY + 1);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = regionW;
        tempCanvas.height = regionH;
        const tempC = tempCanvas.getContext('2d');
        tempC.imageSmoothingEnabled = false;
        // copy this region from overlayCtx
        const regionData = overlayCtx.getImageData(minX, minY, regionW, regionH);
        tempC.putImageData(regionData, 0, 0);
        overlayComposites.push({ canvas: tempCanvas, minX, minY, maxX, maxY });
      } catch (e) {
        console.warn('Could not create overlay composite', e);
      }

      return true;
    }

    function addPendingClaim(imgX, imgY) {
      const team = selectedTeam || null;
      const color = getSelectedTeamColor();
      const claim = { imgX: Math.round(imgX), imgY: Math.round(imgY), date: new Date().toISOString(), team, color };
      pendingClaims.push(claim);
      
      const fillColor = hexToRgba(color || '#cccccc', 128);
      let ok = floodFillOverlay(tempCtx, claim.imgX, claim.imgY, fillColor);
      if (!ok) {
        const found = findNearestWhitePixel(claim.imgX, claim.imgY, 20);
        if (found) ok = floodFillOverlay(tempCtx, found.x, found.y, fillColor);
      }
      updatePendingCount();
      draw();
    }

    function resetPendingClaims() {
      pendingClaims.length = 0;
      if (tempCtx) tempCtx.clearRect(0, 0, tempOverlay.width, tempOverlay.height);
      
      // Clear all composites and force rebuild of saved claims only
      overlayComposites.length = 0;
      renderedClaimIds.clear();
      
      updatePendingCount();
      
      // Rebuild saved claim composites
      reloadSavedClaims();
    }

    async function reloadSavedClaims() {
      const loadingIndicator = document.getElementById('loadingIndicator');
      if (loadingIndicator) loadingIndicator.style.display = 'block';
      
      try {
        const res = await fetch('/claims');
        if (!res.ok) throw new Error('Failed to fetch claims: ' + res.status);
        const body = await res.json();
        const claims = body.claims || [];
        if (typeof lastClaimCount !== 'undefined') lastClaimCount = claims.length;
        
        // Build set of current claim IDs
        const currentIds = new Set(claims.map(c => c.id));
        
        // Only clear and redraw if claims have changed
        const idsChanged = currentIds.size !== renderedClaimIds.size || 
                          ![...currentIds].every(id => renderedClaimIds.has(id));
        
        if (idsChanged) {
          savedCtx.clearRect(0, 0, savedOverlay.width, savedOverlay.height);
          overlayComposites.length = 0;
          debugSeeds.length = 0;
          renderedClaimIds.clear();
          
          claims.forEach(c => {
            const rgba = hexToRgba(c.color || '#000000', 255);
            const seedX = Math.round(c.x), seedY = Math.round(c.y);
            let ok = floodFillOverlay(savedCtx, seedX, seedY, rgba);
            if (!ok) {
              const found = findNearestWhitePixel(seedX, seedY, 80);
              if (found) ok = floodFillOverlay(savedCtx, found.x, found.y, rgba);
            }
            if (ok) renderedClaimIds.add(c.id);
          });
        }
        draw();
      } catch (e) {
        console.error('Failed to reload saved claims', e);
      } finally {
        if (loadingIndicator) loadingIndicator.style.display = 'none';
      }
    }

    async function confirmPendingClaims() {
      if (!pendingClaims.length) return;
      
      try {
        let existing = [];
        try {
          const resExisting = await fetch('/claims');
          if (resExisting.ok) {
            const body = await resExisting.json();
            existing = body.claims || [];
          } else {
            console.warn('Could not fetch existing claims before confirm:', resExisting.status);
          }
        } catch (e) {
          console.warn('Could not fetch existing claims before confirm', e);
        }

        const idsToDelete = new Set();
        try {
          for (const c of existing) {
            const sx = Math.round(c.x), sy = Math.round(c.y);
            if (sx < 0 || sy < 0 || sx >= tempOverlay.width || sy >= tempOverlay.height) continue;
            try {
              const d = tempCtx.getImageData(sx, sy, 1, 1).data;
              if (d[3] > 0) idsToDelete.add(c.id);
            } catch (e) {}
          }
        } catch (e) {
          console.warn('Error while checking overlaps on temp overlay', e);
        }

        if (idsToDelete.size) {
          try {
            const delRes = await fetch('/claims/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: Array.from(idsToDelete) })
            });
            if (!delRes.ok) console.warn('Failed to delete overlapping claims', delRes.status);
          } catch (e) {
            console.warn('Failed to delete overlapping claims', e);
          }
        }

        const nonEmptyClaims = pendingClaims.filter(c => c.team !== '__EMPTY__');

        if (nonEmptyClaims.length > 0) {
          const res = await fetch('/claims', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ claims: nonEmptyClaims })
          });
          if (!res.ok) throw new Error('Server returned ' + res.status);
        }

        resetPendingClaims();
        await reloadSavedClaims();
      } catch (err) {
        console.error('Failed to save claims', err);
        alert('Failed to save claims: ' + err.message);
      }
    }

    const confirmBtn = document.getElementById('confirmBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const clearDbBtn = document.getElementById('clearDbBtn');
    const exportBtn = document.getElementById('exportBtn');
    if (confirmBtn) confirmBtn.addEventListener('click', confirmPendingClaims);
    if (cancelBtn) cancelBtn.addEventListener('click', resetPendingClaims);

    if (exportBtn) exportBtn.addEventListener('click', () => {
      try {
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = img.width;
        exportCanvas.height = img.height;
        const exportCtx = exportCanvas.getContext('2d');
        
        // Draw base image on bottom
        exportCtx.drawImage(img, 0, 0);

        // Draw overlays top
        exportCtx.drawImage(savedOverlay, 0, 0);
                
        // Convert to PNG and download
        exportCanvas.toBlob(blob => {
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `map-with-claims-${Date.now()}.png`;
          a.click();
          URL.revokeObjectURL(url);
        }, 'image/png');
      } catch (err) {
        console.error('Failed to export', err);
        alert('Failed to export: ' + err.message);
      }
    });

    const uploadMapBtn = document.getElementById('uploadMapBtn');
    if (uploadMapBtn) uploadMapBtn.addEventListener('click', async () => {
      const password = prompt('Enter password to upload map:');
      if (!password) return;
      
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        
        const formData = new FormData();
        formData.append('mapImage', file);
        formData.append('password', password);
        
        try {
          const res = await fetch('/upload-map', {
            method: 'POST',
            body: formData
          });
          
          if (!res.ok) {
            const body = await res.json();
            throw new Error(body.error || 'Server returned ' + res.status);
          }
          
          alert('Map uploaded successfully. Reloading page...');
          window.location.reload();
        } catch (err) {
          console.error('Failed to upload map', err);
          alert('Failed to upload map: ' + err.message);
        }
      };
      input.click();
    });

    if (clearDbBtn) clearDbBtn.addEventListener('click', async () => {
      if (!confirm('Clear all saved claims from the database? This cannot be undone.')) return;
      const password = prompt('Enter password to clear database:');
      if (!password) return;
      try {
        const res = await fetch('/claims', { 
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password })
        });
        if (!res.ok) {
          const body = await res.json();
          throw new Error(body.error || 'Server returned ' + res.status);
        }
        
        savedCtx.clearRect(0, 0, savedOverlay.width, savedOverlay.height);
        tempCtx.clearRect(0, 0, tempOverlay.width, tempOverlay.height);
        overlayComposites.length = 0;
        debugSeeds.length = 0;
        renderedClaimIds.clear();
        await reloadSavedClaims();
        alert('Database cleared');
      } catch (err) {
        console.error('Failed to clear DB', err);
        alert('Failed to clear DB: ' + err.message);
      }
    });

    claimRegion = (imgX, imgY) => {
      if (isBaseWhiteXY(Math.floor(imgX), Math.floor(imgY))) {
        addPendingClaim(imgX, imgY);
      }
    };

    draw();
    reloadSavedClaims();
    
    let lastClaimCount = 0;
    setInterval(async () => {
      try {
        const res = await fetch('/claims');
        if (!res.ok) return;
        const body = await res.json();
        const claims = body.claims || [];
        if (claims.length !== lastClaimCount) {
          lastClaimCount = claims.length;
          await reloadSavedClaims();
        }
      } catch (e) {}
    }, 3000);
    
  } catch (err) {
    console.error('Failed to load map image', err);
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#222';
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle = '#fff';
    ctx.font = '16px sans-serif';
    ctx.fillText('Failed to load map image. Check console/network.', 10, 30);
    return;
  }

  function screenToImage(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const imgX = (x - panX) / scale;
    const imgY = (y - panY) / scale;
    return { imgX, imgY, x, y };
  }

  // wheel zoom centered on mouse
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const worldX = (mouseX - panX) / scale;
    const worldY = (mouseY - panY) / scale;
    const delta = -e.deltaY;
    const zoomFactor = Math.exp(delta * 0.0015);
    let newScale = scale * zoomFactor;
    newScale = Math.max(minScale, Math.min(maxScale, newScale));
    panX = mouseX - worldX * newScale;
    panY = mouseY - worldY * newScale;
    scale = newScale;
    draw();
  }, { passive: false });

  // Mouse drag for panning vs click for claiming
  let isDragging = false;
  let dragStartX = 0, dragStartY = 0;
  let startPanX = 0, startPanY = 0;
  let hasMoved = false;
  const MOVE_THRESHOLD = 5;

  canvas.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    startPanX = panX;
    startPanY = panY;
    hasMoved = false;
    canvas.style.cursor = 'grabbing';
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.hypot(dx, dy) > MOVE_THRESHOLD) hasMoved = true;
    if (hasMoved) {
      panX = startPanX + dx;
      panY = startPanY + dy;
      draw();
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    if (!hasMoved) {
      const { imgX, imgY } = screenToImage(e.clientX, e.clientY);
      claimRegion(imgX, imgY);
    }
    isDragging = false;
    hasMoved = false;
    canvas.style.cursor = 'default';
  });

  // Touch support with pinch zoom
  let touchStartDist = 0;
  let touchStartScale = 1;

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      isDragging = true;
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      startPanX = panX;
      startPanY = panY;
      hasMoved = false;
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      touchStartDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      touchStartScale = scale;
      
      dragStartX = (t0.clientX + t1.clientX) / 2;
      dragStartY = (t0.clientY + t1.clientY) / 2;
      hasMoved = true;
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length === 1 && isDragging) {
      const t = e.touches[0];
      const dx = t.clientX - dragStartX;
      const dy = t.clientY - dragStartY;
      if (Math.hypot(dx, dy) > MOVE_THRESHOLD) hasMoved = true;
      if (hasMoved) {
        panX = startPanX + dx;
        panY = startPanY + dy;
        draw();
      }
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const t0 = e.touches[0];
      const t1 = e.touches[1];
      
      const currentDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const currentCenter = {
        x: (t0.clientX + t1.clientX) / 2,
        y: (t0.clientY + t1.clientY) / 2
      };
      
      const scaleFactor = currentDist / touchStartDist;
      let newScale = touchStartScale * scaleFactor;
      newScale = Math.max(minScale, Math.min(maxScale, newScale));
      
      const rect = canvas.getBoundingClientRect();
      const centerX = currentCenter.x - rect.left;
      const centerY = currentCenter.y - rect.top;
      
      const oldImgX = (centerX - panX) / scale;
      const oldImgY = (centerY - panY) / scale;
      
      panX = centerX - oldImgX * newScale;
      panY = centerY - oldImgY * newScale;
      scale = newScale;
      
      draw();
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length === 0) {
      if (!hasMoved && isDragging) {
        const t = e.changedTouches[0];
        const { imgX, imgY } = screenToImage(t.clientX, t.clientY);
        claimRegion(imgX, imgY);
      }
      isDragging = false;
      hasMoved = false;
      touchStartDist = 0;
    } else if (e.touches.length === 1) {
      const t = e.touches[0];
      isDragging = true;
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      startPanX = panX;
      startPanY = panY;
      hasMoved = true;
    }
  });

  draw();
});