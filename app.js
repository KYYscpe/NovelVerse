const $ = (q) => document.querySelector(q);

const state = {
  me: null,
  novels: [],
  current: null,

  coverUrl: null,
  chapters: [],

  tagSelected: new Set(),
};

function toast(msg){
  const t = $("#toast");
  if(!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>t.classList.remove("show"), 1600);
}

function escapeHTML(str){
  return (str ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function qs(name){
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

async function api(path, opts){
  const res = await fetch(path, opts);
  const json = await res.json().catch(()=> ({}));
  return { res, json };
}

/* ===== AUTH MODAL ===== */
function openModal(){ $("#authModal")?.classList.add("show"); }
function closeModal(){ $("#authModal")?.classList.remove("show"); }

function showTab(tab){
  const login = $("#panelLogin");
  const reg = $("#panelRegister");
  if(!login || !reg) return;

  if(tab === "login"){
    login.style.display = "";
    reg.style.display = "none";
  } else {
    login.style.display = "none";
    reg.style.display = "";
  }
}

async function refreshMe(){
  const { json } = await api("/api/auth/me");
  state.me = json.user || null;

  $("#userPill") && ($("#userPill").textContent = state.me ? state.me.email : "Guest");

  const loginBtn = $("#loginBtn");
  const registerBtn = $("#registerBtn");
  const logoutBtn = $("#logoutBtn");

  if(state.me){
    loginBtn && (loginBtn.style.display = "none");
    registerBtn && (registerBtn.style.display = "none");
    logoutBtn && (logoutBtn.style.display = "");
  }else{
    loginBtn && (loginBtn.style.display = "");
    registerBtn && (registerBtn.style.display = "");
    logoutBtn && (logoutBtn.style.display = "none");
  }

  const lockBox = $("#createLockBox");
  if(lockBox){
    if(!state.me) lockBox.classList.add("lock");
    else lockBox.classList.remove("lock");
  }
}

function bindAuthUI(){
  $("#loginBtn")?.addEventListener("click", ()=>{ openModal(); showTab("login"); });
  $("#registerBtn")?.addEventListener("click", ()=>{ openModal(); showTab("register"); });

  $("#logoutBtn")?.addEventListener("click", async ()=>{
    await api("/api/auth/logout", { method:"POST" });
    await refreshMe();
    toast("Logout berhasil");
  });

  $("#authModal")?.addEventListener("click", (e)=>{
    if(e.target?.dataset?.close) closeModal();
  });

  $("#tabLogin")?.addEventListener("click", ()=> showTab("login"));
  $("#tabRegister")?.addEventListener("click", ()=> showTab("register"));

  $("#doLogin")?.addEventListener("click", async ()=>{
    const email = ($("#lEmail")?.value || "").trim();
    const pass = $("#lPass")?.value || "";
    $("#loginMsg") && ($("#loginMsg").textContent = "");
    const { res, json } = await api("/api/auth/login", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({ email, password: pass })
    });
    if(!res.ok){
      $("#loginMsg") && ($("#loginMsg").textContent = json.error || "Login gagal");
      return;
    }
    await refreshMe();
    closeModal();
    toast("Login berhasil");
  });

  // Kirim OTP code
  $("#sendCodeBtn")?.addEventListener("click", async ()=>{
    const email = ($("#rEmail")?.value || "").trim();
    $("#registerMsg") && ($("#registerMsg").textContent = "");
    const { res, json } = await api("/api/auth/request-code", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({ email, purpose:"register" })
    });
    if(!res.ok){
      $("#registerMsg") && ($("#registerMsg").textContent = json.error || "Gagal kirim kode");
      return;
    }
    toast("Kode dikirim ke Gmail");
  });

  // Register pakai OTP
  $("#doRegister")?.addEventListener("click", async ()=>{
    const email = ($("#rEmail")?.value || "").trim();
    const pass = $("#rPass")?.value || "";
    const code = ($("#rCode")?.value || "").trim();
    $("#registerMsg") && ($("#registerMsg").textContent = "");

    const { res, json } = await api("/api/auth/register", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({ email, password: pass, code })
    });
    if(!res.ok){
      $("#registerMsg") && ($("#registerMsg").textContent = json.error || "Register gagal");
      return;
    }
    await refreshMe();
    closeModal();
    toast("Register sukses");
  });
}

/* ===== PICK: Search + Tag Filter ===== */
async function loadNovels(){
  const { res, json } = await api("/api/novels");
  if(!res.ok) throw new Error(json.error || "Gagal ambil novel");
  state.novels = json.novels || [];
}

function getAllTags(novels){
  const m = new Map();
  for(const n of novels){
    const tags = Array.isArray(n.tags) ? n.tags : [];
    for(const t of tags){
      const tag = String(t||"").trim();
      if(!tag) continue;
      m.set(tag, (m.get(tag)||0) + 1);
    }
  }
  return Array.from(m.entries())
    .sort((a,b)=> (b[1]-a[1]) || a[0].localeCompare(b[0]))
    .map(([tag,count])=>({ tag, count }));
}

function renderTagFilters(){
  const box = $("#tagFilters");
  if(!box) return;

  const tags = getAllTags(state.novels);
  box.innerHTML = "";

  const hint = $("#tagHint");
  const sel = Array.from(state.tagSelected);
  if(hint){
    hint.textContent = sel.length ? `(${sel.join(", ")})` : "(tidak ada)";
  }

  for(const x of tags){
    const chip = document.createElement("span");
    chip.className = "tag" + (state.tagSelected.has(x.tag) ? " active" : "");
    chip.style.cursor = "pointer";
    chip.textContent = `${x.tag} (${x.count})`;
    chip.addEventListener("click", ()=>{
      if(state.tagSelected.has(x.tag)) state.tagSelected.delete(x.tag);
      else state.tagSelected.add(x.tag);
      renderTagFilters();
      renderPick();
    });
    box.appendChild(chip);
  }

  $("#clearTags")?.addEventListener("click", ()=>{
    state.tagSelected.clear();
    renderTagFilters();
    renderPick();
  });
}

function renderPick(){
  const grid = $("#grid");
  const empty = $("#empty");
  if(!grid) return;

  const q = ($("#search")?.value || "").toLowerCase().trim();
  const sort = $("#sort")?.value || "new";
  const selected = state.tagSelected;

  let arr = [...state.novels];

  // search
  if(q){
    arr = arr.filter(n=>{
      const blob = [n.title, n.author_email, (n.tags||[]).join(" "), n.synopsis].join(" ").toLowerCase();
      return blob.includes(q);
    });
  }

  // filter tag (multi select): novel harus punya semua tag yang dipilih
  if(selected.size){
    arr = arr.filter(n=>{
      const tags = new Set((n.tags||[]).map(t=>String(t).trim()));
      for(const t of selected){
        if(!tags.has(t)) return false;
      }
      return true;
    });
  }

  // sort
  if(sort === "likes"){
    arr.sort((a,b)=> (b.likes||0) - (a.likes||0));
  } else if(sort === "title"){
    arr.sort((a,b)=> (a.title||"").localeCompare(b.title||""));
  } else {
    arr.sort((a,b)=> (b.updated_at||"").localeCompare(a.updated_at||""));
  }

  grid.innerHTML = "";
  empty && (empty.style.display = arr.length ? "none" : "");

  for(const n of arr){
    const el = document.createElement("div");
    el.className = "novel";
    el.innerHTML = `
      <div class="cover">${n.cover_url ? `<img alt="cover" src="${n.cover_url}">` : ""}</div>
      <div class="nbody">
        <h3 class="ntitle">${escapeHTML(n.title || "Tanpa Judul")}</h3>
        <div class="meta">${escapeHTML(n.author_email || "anon")} • ${(n.likes||0)} ♥ • ${(n.chapters?.length||0)} chapter</div>
        <div class="tags">${(n.tags||[]).slice(0,4).map(t=>`<span class="tag">${escapeHTML(t)}</span>`).join("")}</div>
        <div class="row">
          <button class="btn" data-like="1">♡ Like</button>
          <button class="btn primary" data-read="1">Baca</button>
        </div>
      </div>
    `;

    el.querySelector("[data-read]")?.addEventListener("click", ()=>{
      location.href = `read.html?id=${encodeURIComponent(n.id)}`;
    });

    el.querySelector("[data-like]")?.addEventListener("click", async ()=>{
      const r = await fetch(`/api/novels/${n.id}/like`, { method:"POST" });
      if(r.status === 401){
        toast("Login dulu untuk like");
        openModal(); showTab("login");
        return;
      }
      await loadNovels();
      renderTagFilters();
      renderPick();
      toast("Like diupdate");
    });

    grid.appendChild(el);
  }

  $("#search")?.addEventListener("input", renderPick);
  $("#sort")?.addEventListener("change", renderPick);
  $("#goCreate")?.addEventListener("click", ()=> location.href = "create.html");
}

/* ===== CREATE ===== */
function renderChapterList(){
  const list = $("#chapterList");
  if(!list) return;

  list.innerHTML = "";
  state.chapters.forEach((c, i)=>{
    const item = document.createElement("div");
    item.className = "chapter";
    item.innerHTML = `
      <h2>${escapeHTML(c.title?.trim() ? c.title : `Chapter ${i+1}`)}</h2>
      <div class="body">${escapeHTML(c.body.slice(0,220))}${c.body.length>220 ? "…" : ""}</div>
      <div style="margin-top:12px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn" data-up="1">↑</button>
        <button class="btn" data-down="1">↓</button>
        <button class="btn danger" data-del="1">Hapus</button>
      </div>
    `;
    item.querySelector("[data-up]")?.addEventListener("click", ()=>{
      if(i===0) return;
      const tmp = state.chapters[i-1]; state.chapters[i-1]=state.chapters[i]; state.chapters[i]=tmp;
      renderChapterList();
    });
    item.querySelector("[data-down]")?.addEventListener("click", ()=>{
      if(i===state.chapters.length-1) return;
      const tmp = state.chapters[i+1]; state.chapters[i+1]=state.chapters[i]; state.chapters[i]=tmp;
      renderChapterList();
    });
    item.querySelector("[data-del]")?.addEventListener("click", ()=>{
      state.chapters.splice(i,1);
      renderChapterList();
    });
    list.appendChild(item);
  });
}

async function uploadCoverDataUrl(dataUrl, filename){
  const { res, json } = await api("/api/upload-cover", {
    method:"POST",
    headers:{ "content-type":"application/json" },
    body: JSON.stringify({ dataUrl, filename })
  });
  if(res.status === 401) throw new Error("Login dulu untuk upload cover");
  if(!res.ok) throw new Error(json.error || "Upload gagal");
  return json.url;
}

function bindCreate(){
  $("#addChapter")?.addEventListener("click", ()=>{
    if(!state.me){ toast("Login dulu"); openModal(); showTab("login"); return; }

    const t = ($("#cTitle")?.value || "").trim();
    const b = ($("#cBody")?.value || "").trim();
    if(!b){ toast("Isi chapter kosong"); return; }

    state.chapters.push({ title: t, body: b });
    $("#cTitle").value = "";
    $("#cBody").value = "";
    renderChapterList();
    toast("Chapter ditambah");
  });

  $("#coverFile")?.addEventListener("change", async (e)=>{
    if(!state.me){ toast("Login dulu"); openModal(); showTab("login"); e.target.value=""; return; }
    const f = e.target.files?.[0];
    if(!f) return;
    if(f.size > 2_500_000){ toast("Cover terlalu besar"); e.target.value=""; return; }

    const reader = new FileReader();
    reader.onload = async ()=>{
      const dataUrl = String(reader.result);
      $("#coverPreview") && ($("#coverPreview").innerHTML = `<img alt="cover" src="${dataUrl}">`);
      try{
        state.coverUrl = await uploadCoverDataUrl(dataUrl, f.name);
        toast("Cover tersimpan permanen");
      }catch(err){
        toast(err.message);
      }
    };
    reader.readAsDataURL(f);
  });

  $("#removeCover")?.addEventListener("click", ()=>{
    state.coverUrl = null;
    $("#coverPreview") && ($("#coverPreview").innerHTML = "");
    $("#coverFile") && ($("#coverFile").value = "");
    toast("Cover dihapus");
  });

  $("#saveNovel")?.addEventListener("click", async ()=>{
    if(!state.me){ toast("Login dulu"); openModal(); showTab("login"); return; }

    const title = ($("#title")?.value || "").trim();
    const synopsis = ($("#synopsis")?.value || "").trim();
    const tags = ($("#tags")?.value || "").split(",").map(t=>t.trim()).filter(Boolean).slice(0,12);

    if(!title) return ($("#saveMsg").textContent = "Judul wajib diisi.");
    if(state.chapters.length < 1) return ($("#saveMsg").textContent = "Minimal 1 chapter.");

    $("#saveMsg").textContent = "";

    const { res, json } = await api("/api/novels", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({
        title, synopsis, tags,
        coverUrl: state.coverUrl,
        chapters: state.chapters
      })
    });

    if(res.status === 401){
      toast("Session habis, login lagi");
      openModal(); showTab("login");
      return;
    }
    if(!res.ok){
      $("#saveMsg").textContent = json.error || "Gagal simpan";
      return;
    }

    toast("Novel tersimpan permanen");
    location.href = `read.html?id=${encodeURIComponent(json.id)}`;
  });

  renderChapterList();
}

/* ===== READ ===== */
async function loadNovel(id){
  const { res, json } = await api(`/api/novels/${id}`);
  if(!res.ok) throw new Error(json.error || "Novel tidak ditemukan");
  state.current = json.novel;
}

function renderRead(){
  const n = state.current;
  if(!n) return;

  $("#rTitle") && ($("#rTitle").textContent = n.title || "Tanpa Judul");
  $("#rMeta") && ($("#rMeta").textContent = `${n.author_email} • ${(n.likes||0)} likes • ${(n.chapters?.length||0)} chapter`);

  const cover = $("#rCover");
  if(cover){
    cover.innerHTML = n.cover_url
      ? `<img alt="cover" src="${n.cover_url}">`
      : `<div style="height:100%;display:grid;place-items:center;color:rgba(255,255,255,.45)">No Cover</div>`;
  }

  $("#rLikes") && ($("#rLikes").textContent = `${n.likes||0} likes`);
  $("#rTags") && ($("#rTags").innerHTML = (n.tags||[]).map(t=>`<span class="tag">${escapeHTML(t)}</span>`).join(""));

  const toc = $("#toc");
  const wrap = $("#chaptersWrap");
  toc && (toc.innerHTML = "");
  wrap && (wrap.innerHTML = "");

  (n.chapters || []).forEach((c, i)=>{
    const a = document.createElement("a");
    a.href = `#ch-${i}`;
    a.textContent = c.title?.trim() ? c.title : `Chapter ${i+1}`;
    toc?.appendChild(a);

    const ch = document.createElement("div");
    ch.className = "chapter";
    ch.id = `ch-${i}`;
    ch.innerHTML = `
      <h2>${escapeHTML(c.title?.trim() ? c.title : `Chapter ${i+1}`)}</h2>
      <div class="body">${escapeHTML(c.body || "")}</div>
    `;
    wrap?.appendChild(ch);
  });

  $("#likeBtn")?.addEventListener("click", async ()=>{
    const r = await fetch(`/api/novels/${n.id}/like`, { method:"POST" });
    if(r.status === 401){
      toast("Login dulu untuk like");
      openModal(); showTab("login");
      return;
    }
    await loadNovel(n.id);
    renderRead();
    toast("Like diupdate");
  });
}

/* ===== BOOT ===== */
(async function boot(){
  bindAuthUI();
  await refreshMe();

  const page = document.body.dataset.page;

  if(page === "pick"){
    await loadNovels();
    renderTagFilters();
    renderPick();
  }

  if(page === "create"){
    $("#coverPreview") && ($("#coverPreview").innerHTML = `<div style="height:100%;display:grid;place-items:center;color:rgba(255,255,255,.45)">No Cover</div>`);
    bindCreate();
  }

  if(page === "read"){
    const id = qs("id");
    if(!id){ toast("Pilih novel dulu di halaman Pilih"); return; }
    await loadNovel(id);
    renderRead();
  }
})();
