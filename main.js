// main.js
// Pan/zoom canvas + click-vs-drag detection, loads ServerSettings.json -> settings.mapImage

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
    img.crossOrigin = 'anonymous'; // helps with CORS and pixel access
    console.log('Starting image load:', src);
    img.onload = () => {
      console.log('Image loaded:', src, 'size=', img.width, 'x', img.height);
      resolve(img);
    };
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
  const minScale = 0.1, maxScale = 10;

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

    // Instead of relying on transforms, draw the base image / overlays with explicit dest rects
    const destX = Math.round(panX * dpr);
    const destY = Math.round(panY * dpr);
    const destW = Math.round(img.width * dpr * scale);
    const destH = Math.round(img.height * dpr * scale);

    // draw base image to the canvas (device-pixel coords)
    ctx.setTransform(1,0,0,1,0,0);
    ctx.drawImage(img, 0, 0, img.width, img.height, destX, destY, destW, destH);

    // draw overlays using same dest rect, composited over the base image
    try {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      if (typeof savedOverlay !== 'undefined') ctx.drawImage(savedOverlay, 0, 0, savedOverlay.width, savedOverlay.height, destX, destY, destW, destH);
      if (typeof tempOverlay !== 'undefined') ctx.drawImage(tempOverlay, 0, 0, tempOverlay.width, tempOverlay.height, destX, destY, destW, destH);

      // draw transient overlay composites (small region canvases) on top to guarantee visibility
      overlayComposites.forEach(o => {
        try {
          const sx = o.minX, sy = o.minY, sw = o.canvas.width, sh = o.canvas.height;
          const dx = Math.round(sx * dpr * scale + panX * dpr);
          const dy = Math.round(sy * dpr * scale + panY * dpr);
          const dw = Math.round(sw * dpr * scale);
          const dh = Math.round(sh * dpr * scale);
          ctx.drawImage(o.canvas, 0, 0, sw, sh, dx, dy, dw, dh);
        } catch (e) {
          /* ignore */
        }
      });
      // optionally keep overlayComposites small — they will be cleared when overlays are reloaded or cleared explicitly
      if (overlayComposites.length > 200) overlayComposites.shift();
    } finally {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // helper to map image coords to canvas pixels
    function imgToCanvasX(x) { return Math.round(x * dpr * scale + panX * dpr); }
    function imgToCanvasY(y) { return Math.round(y * dpr * scale + panY * dpr); }

    // draw pending claim markers on top (still useful as quick visual)
    if (pendingClaims && pendingClaims.length) {
      pendingClaims.forEach(c => {
        const markerSize = Math.max(4, Math.round(8 * dpr * scale)); // in canvas pixels
        const cx = imgToCanvasX(c.imgX);
        const cy = imgToCanvasY(c.imgY);
        ctx.fillStyle = c.color || 'rgba(0,255,0,0.8)';
        ctx.fillRect(cx - markerSize/2, cy - markerSize/2, markerSize, markerSize);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = Math.max(1, Math.round(1 * dpr));
        ctx.strokeRect(cx - markerSize/2, cy - markerSize/2, markerSize, markerSize);
      });
    }

    // DEBUG: draw overlay thumbnails in the top-left so we can inspect overlay pixels visually
    try {
      const thumbW = Math.min(200, savedOverlay ? savedOverlay.width : 0);
      const thumbH = Math.min(200, savedOverlay ? savedOverlay.height : 0);
      if (savedOverlay && thumbW && thumbH) {
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
        ctx.drawImage(savedOverlay, 0, 0, thumbW, thumbH, 8, 8, thumbW, thumbH);
        ctx.strokeRect(8,8,thumbW,thumbH);
        ctx.fillStyle = '#000'; ctx.fillRect(8, 8+thumbH, thumbW, 16);
        ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.fillText('saved', 12, 8+thumbH+12);
      }
      if (tempOverlay) {
        const thumbW2 = Math.min(200, tempOverlay.width);
        const thumbH2 = Math.min(200, tempOverlay.height);
        ctx.drawImage(tempOverlay, 0, 0, thumbW2, thumbH2, 16+thumbW, 8, thumbW2, thumbH2);
        ctx.strokeRect(16+thumbW,8,thumbW2,thumbH2);
        ctx.fillStyle = '#000'; ctx.fillRect(16+thumbW, 8+thumbH2, thumbW2, 16);
        ctx.fillStyle = '#fff'; ctx.fillText('temp', 20+thumbW, 8+thumbH2+12);
      }
    } catch (e) {
      /* ignore */
    }

    // debug bounding boxes removed

    // reset transform
    ctx.setTransform(1,0,0,1,0,0);
  }

  function resizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    // Size the backing store in device pixels so rendering stays sharp on high-DPI displays
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
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
    const color = settings.Teams && settings.Teams[teamName] && settings.Teams[teamName].color;
    teamSwatch.style.backgroundColor = color || 'transparent';
    teamSwatch.title = teamName ? `${teamName} (${color})` : '';
  }

  if (teamSelect && settings.Teams && Object.keys(settings.Teams).length) {
    teamSelect.innerHTML = '';
    const names = Object.keys(settings.Teams);
    names.forEach((name) => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      teamSelect.appendChild(opt);
    });
    selectedTeam = names[0];
    teamSelect.value = selectedTeam;
    updateSwatch(selectedTeam);
    teamSelect.addEventListener('change', (e) => {
      selectedTeam = e.target.value;
      updateSwatch(selectedTeam);
      console.log('Selected team:', selectedTeam, 'color=', getSelectedTeamColor());
    });
  } else {
    if (teamSelect) teamSelect.style.display = 'none';
    if (teamSwatch) teamSwatch.style.display = 'none';
  }

  function getSelectedTeamColor() {
    return settings.Teams && settings.Teams[selectedTeam] && settings.Teams[selectedTeam].color;
  }

  // ----- load the image (same as before) -----
  if (!settings.mapImage) {
    console.warn('mapImage not set in ServerSettings.json');
    return;
  }

  try {
    img = await loadImage(settings.mapImage);
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

    // debug markers when we had to pick a nearby seed (for visibility)
    // (uses outer `debugSeeds` array defined in state)
    // pending claims storage
    const pendingClaims = []; // {imgX, imgY, date, team, color}

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
      const r = baseData[idx], g = baseData[idx+1], b = baseData[idx+2], a = baseData[idx+3];
      const tol = 250;
      return a > 200 && r >= tol && g >= tol && b >= tol;
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
      let minX = w, minY = h, maxX = 0, maxY = 0;

      while (stack.length) {
        const p = stack.pop();
        let x = p.x;
        let y = p.y;

        // move to leftmost pixel of this span
        while (x > 0 && isBaseWhiteXY(x - 1, y) && !pixelHasFill(getIndex(x - 1, y)) && !visited[y * w + (x - 1)]) x--;
        // move to rightmost pixel of this span
        let x2 = x;
        while (x2 < w - 1 && isBaseWhiteXY(x2 + 1, y) && !pixelHasFill(getIndex(x2 + 1, y)) && !visited[y * w + (x2 + 1)]) x2++;

        // fill span x..x2
        for (let i = x; i <= x2; i++) {
          const idx = getIndex(i, y);
          if (visited[y * w + i]) continue;
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
        }

        // check the line above and below for new spans
        for (let i = x; i <= x2; i++) {
          // above
          if (y > 0 && isBaseWhiteXY(i, y - 1) && !pixelHasFill(getIndex(i, y - 1)) && !visited[(y - 1) * w + i]) {
            stack.push({ x: i, y: y - 1 });
          }
          // below
          if (y < h - 1 && isBaseWhiteXY(i, y + 1) && !pixelHasFill(getIndex(i, y + 1)) && !visited[(y + 1) * w + i]) {
            stack.push({ x: i, y: y + 1 });
          }
        }
      }

      if (filledCount === 0) return false;
      overlayCtx.putImageData(imgData, 0, 0);
      // sample a pixel at seed to confirm overlay contains color
      try {
        const probe = overlayCtx.getImageData(sx, sy, 1, 1).data;
        console.log('floodFillOverlay: overlay sample at seed RGBA=', probe[0], probe[1], probe[2], probe[3]);
      } catch (e) {
        console.warn('floodFillOverlay: could not sample overlay pixel (tainted?)', e);
      }

      // no bounding box drawing — rely on overlay mask for fill visibility
      console.log('floodFillOverlay: filled', filledCount, 'pixels at seed', sx, sy, 'bbox', minX, minY, maxX, maxY);

      // create a small transient canvas for the filled region and store it so draw() can composite it visibly
      try {
        const regionW = Math.max(1, maxX - minX);
        const regionH = Math.max(1, maxY - minY);
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = regionW;
        tempCanvas.height = regionH;
        const tempC = tempCanvas.getContext('2d');
        // copy this region from overlayCtx
        const regionData = overlayCtx.getImageData(minX, minY, regionW, regionH);
        tempC.putImageData(regionData, 0, 0);
        overlayComposites.push({ canvas: tempCanvas, minX, minY, maxX, maxY });
        if (overlayComposites.length > 50) overlayComposites.shift();
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
      console.log('Added pending claim', claim);
      // apply temporary gray fill to temp overlay
      const gray = hexToRgba('#cccccc', 200);
      let ok = floodFillOverlay(tempCtx, claim.imgX, claim.imgY, gray);
      if (!ok) {
        console.log('Flood fill failed for pending claim at', claim.imgX, claim.imgY, '- sampled:', sampleBaseRGBA(claim.imgX, claim.imgY));
        const found = findNearestWhitePixel(claim.imgX, claim.imgY, 20);
        if (found) {
          console.log('Found nearby white pixel for pending claim at', found.x, found.y, ' — using that seed');
          ok = floodFillOverlay(tempCtx, found.x, found.y, gray);
        }
        if (!ok) console.log('Pending claim flood-fill still failed at', claim.imgX, claim.imgY);
      }
      updatePendingCount();
      draw();
    }

    function resetPendingClaims() {
      pendingClaims.length = 0;
      if (tempCtx) tempCtx.clearRect(0,0,tempOverlay.width,tempOverlay.height);
      overlayComposites.length = 0;
      updatePendingCount();
      draw();
    }

    async function reloadSavedClaims() {
      try {
        const res = await fetch('/claims');
        if (!res.ok) throw new Error('Failed to fetch claims: ' + res.status);
        const body = await res.json();
        const claims = body.claims || [];
        // clear saved overlay
        savedCtx.clearRect(0,0,savedOverlay.width,savedOverlay.height);
        overlayComposites.length = 0;
        debugSeeds.length = 0;
        // apply each saved claim
        claims.forEach(c => {
          const rgba = hexToRgba(c.color || '#000000', 255);
          const seedX = Math.round(c.x), seedY = Math.round(c.y);
          let ok = floodFillOverlay(savedCtx, seedX, seedY, rgba);
                  if (!ok) {
            // try to find nearby white pixel and retry
            console.log('Saved claim flood-fill failed at', seedX, seedY, '- sampling base pixel:', sampleBaseRGBA(seedX, seedY));
            const found = findNearestWhitePixel(seedX, seedY, 80);
            if (found) {
              console.log('Found nearby white pixel for saved claim at', found.x, found.y, ' — retrying fill');
              // store debug marker to show where we seeded
              debugSeeds.push({ x: found.x, y: found.y, color: '#f0f' });
              if (debugSeeds.length > 100) debugSeeds.shift();
              ok = floodFillOverlay(savedCtx, found.x, found.y, rgba);
              if (ok) console.log('Saved claim filled at nearby seed', found.x, found.y);
            }
            if (!ok) console.log('Saved claim flood-fill still failed at', seedX, seedY);
          }
        });
        draw();
      } catch (e) {
        console.error('Failed to reload saved claims', e);
      }
    }

    async function confirmPendingClaims() {
      if (!pendingClaims.length) return;
      try {
        // fetch existing saved claims and detect overlaps with the temporary overlay
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

        // collect IDs of existing claims whose saved point lies inside any pending fill (sample temp overlay alpha)
        const idsToDelete = new Set();
        try {
          for (const c of existing) {
            const sx = Math.round(c.x), sy = Math.round(c.y);
            if (sx < 0 || sy < 0 || sx >= tempOverlay.width || sy >= tempOverlay.height) continue;
            try {
              const d = tempCtx.getImageData(sx, sy, 1, 1).data;
              if (d[3] > 0) idsToDelete.add(c.id);
            } catch (e) {
              // sampling can fail if canvas is tainted (shouldn't be) — ignore
            }
          }
        } catch (e) {
          console.warn('Error while checking overlaps on temp overlay', e);
        }

        // delete overlapping claims first (so we're effectively overwriting)
        if (idsToDelete.size) {
          try {
            const delRes = await fetch('/claims/delete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: Array.from(idsToDelete) })
            });
            if (!delRes.ok) console.warn('Failed to delete overlapping claims', delRes.status);
            else console.log('Deleted overlapping claims', Array.from(idsToDelete));
          } catch (e) {
            console.warn('Failed to delete overlapping claims', e);
          }
        }

        // now POST new claims
        const res = await fetch('/claims', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claims: pendingClaims })
        });
        if (!res.ok) throw new Error('Server returned ' + res.status);
        const body = await res.json();
        console.log('Saved claims', body);
        resetPendingClaims();
        await reloadSavedClaims();
      } catch (err) {
        console.error('Failed to save claims', err);
        alert('Failed to save claims: ' + err.message);
      }
    }

    // wire toolbar buttons
    const confirmBtn = document.getElementById('confirmBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const clearDbBtn = document.getElementById('clearDbBtn');
    if (confirmBtn) confirmBtn.addEventListener('click', confirmPendingClaims);
    if (cancelBtn) cancelBtn.addEventListener('click', resetPendingClaims);

    // clear DB button (debug) — asks for confirmation then calls DELETE /claims
    if (clearDbBtn) clearDbBtn.addEventListener('click', async () => {
      if (!confirm('Clear all saved claims from the database? This cannot be undone.')) return;
      try {
        const res = await fetch('/claims', { method: 'DELETE' });
        if (!res.ok) throw new Error('Server returned ' + res.status);
        const body = await res.json();
        console.log('Cleared DB:', body);
        // clear overlays and reload
        savedCtx.clearRect(0,0,savedOverlay.width,savedOverlay.height);
        tempCtx.clearRect(0,0,tempOverlay.width,tempOverlay.height);
        overlayComposites.length = 0;
        debugSeeds.length = 0;
        await reloadSavedClaims();
        alert('Database cleared');
      } catch (err) {
        console.error('Failed to clear DB', err);
        alert('Failed to clear DB: ' + err.message);
      }
    });

    // override claimRegion to check image pixel and add pending claim if white
    claimRegion = (imgX, imgY) => {
      if (!isBaseWhiteXY(Math.floor(imgX), Math.floor(imgY))) {
        console.log('Clicked non-white pixel — ignoring claim at', imgX, imgY);
        return;
      }
      addPendingClaim(imgX, imgY);
    };

    // ensure we render now that image is available
    draw();
    // also load saved claims so the overlay shows past fills
    reloadSavedClaims();
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

  // mouse drag vs click
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
      if (typeof claimRegion === 'function') {
        claimRegion(imgX, imgY);
      } else {
        console.log('click at image coords:', imgX, imgY);
      }
    }
    isDragging = false;
    hasMoved = false;
    canvas.style.cursor = 'default';
  });

  // basic touch support (pan + tap)
  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      isDragging = true;
      dragStartX = t.clientX;
      dragStartY = t.clientY;
      startPanX = panX;
      startPanY = panY;
      hasMoved = false;
    }
  }, { passive: true });

  canvas.addEventListener('touchmove', (e) => {
    if (!isDragging || e.touches.length !== 1) return;
    const t = e.touches[0];
    const dx = t.clientX - dragStartX;
    const dy = t.clientY - dragStartY;
    if (Math.hypot(dx, dy) > MOVE_THRESHOLD) hasMoved = true;
    if (hasMoved) {
      panX = startPanX + dx;
      panY = startPanY + dy;
      draw();
    }
  }, { passive: true });

  canvas.addEventListener('touchend', (e) => {
    if (!isDragging) return;
    if (!hasMoved) {
      const t = e.changedTouches[0];
      const { imgX, imgY } = screenToImage(t.clientX, t.clientY);
      if (typeof claimRegion === 'function') claimRegion(imgX, imgY);
    }
    isDragging = false;
    hasMoved = false;
  });

  draw();
});