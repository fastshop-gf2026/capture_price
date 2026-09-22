(() => {
  const cfg = window.COLETA || {};
  const API = "https://api.github.com";
  const TOKEN_KEY = "fastshop-coleta-unlocked";

  const $ = (id) => document.getElementById(id);
  const fileInput = $("coleta-file");
  const openBtn = $("btn-enviar-planilha");
  const overlay = $("coleta-overlay");
  const closeBtn = $("coleta-fechar");
  const titleEl = $("coleta-titulo");
  const subtitleEl = $("coleta-subtitulo");
  const pinBox = $("coleta-pin-box");
  const pinInput = $("coleta-pin");
  const pinBtn = $("coleta-pin-ok");
  const pinError = $("coleta-pin-erro");
  const jobsEl = $("coleta-jobs");
  const barEl = $("coleta-bar");
  const actionsEl = $("coleta-acoes");
  const reportLink = $("coleta-relatorio");
  const actionsLink = $("coleta-actions");

  let selectedFile = null;
  let pollTimer = null;

  function token() {
    return cfg.token || "";
  }

  function needsPin() {
    return Boolean(cfg.pin) && sessionStorage.getItem(TOKEN_KEY) !== "1";
  }

  function openOverlay() {
    overlay.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeOverlay() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    overlay.hidden = true;
    document.body.style.overflow = "";
  }

  function setPhase(title, subtitle) {
    titleEl.textContent = title;
    subtitleEl.textContent = subtitle || "";
  }

  function showPin() {
    pinBox.hidden = false;
    jobsEl.innerHTML = "";
    actionsEl.hidden = true;
    barEl.style.width = "0%";
    pinError.hidden = true;
    pinInput.value = "";
    pinInput.focus();
  }

  function hidePin() {
    pinBox.hidden = true;
  }

  async function api(path, options = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    };
    if (token()) headers.Authorization = `Bearer ${token()}`;
    const response = await fetch(`${API}${path}`, { ...options, headers });
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    if (!response.ok) {
      throw new Error(data.message || `GitHub API ${response.status}`);
    }
    return data;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  async function resetEntradaBranch() {
    const main = await api(`/repos/${cfg.repo}/git/ref/heads/main`);
    const sha = main.object.sha;
    try {
      await api(`/repos/${cfg.repo}/git/refs/heads/${cfg.branch}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha, force: true }),
      });
    } catch {
      await api(`/repos/${cfg.repo}/git/refs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: `refs/heads/${cfg.branch}`, sha }),
      });
    }
  }

  async function uploadPlanilha(file) {
    const suffix = file.name.toLowerCase().endsWith(".csv") ? ".csv" : ".xlsx";
    const path = `data/entrada/planilha${suffix}`;
    const buffer = new Uint8Array(await file.arrayBuffer());
    let currentSha;
    try {
      const current = await api(
        `/repos/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`,
      );
      currentSha = current.sha;
    } catch {
      currentSha = undefined;
    }
    const result = await api(`/repos/${cfg.repo}/contents/${path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `coleta: ${file.name}`,
        content: bytesToBase64(buffer),
        branch: cfg.branch,
        sha: currentSha,
      }),
    });
    return result.commit.sha;
  }

  async function waitForRun(headSha) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const payload = await api(
        `/repos/${cfg.repo}/actions/runs?head_sha=${headSha}&per_page=5`,
      );
      const run = (payload.workflow_runs || [])[0];
      if (run) return run;
      await sleep(2000);
    }
    throw new Error("A captura não apareceu nas Actions. Tente de novo em alguns segundos.");
  }

  function statusIcon(status, conclusion) {
    if (status === "completed" && conclusion === "success") return "ok";
    if (status === "completed" && conclusion === "skipped") return "skip";
    if (status === "completed") return "fail";
    if (status === "in_progress") return "run";
    return "wait";
  }

  function renderJobs(jobs, run) {
    const total = jobs.length || 1;
    const done = jobs.filter((job) => job.status === "completed").length;
    const running = jobs.find((job) => job.status === "in_progress");
    barEl.style.width = `${Math.round((done / total) * 100)}%`;

    const state =
      run.status === "queued"
        ? "Na fila do GitHub Actions…"
        : running
          ? `Em andamento: ${running.name}`
          : run.status === "completed"
            ? run.conclusion === "success"
              ? "Coleta concluída"
              : "A coleta terminou com falha"
            : "Preparando a captura…";
    setPhase(state, run.html_url ? "Acompanhe os jobs abaixo." : "");

    jobsEl.innerHTML = jobs
      .map((job) => {
        const klass = statusIcon(job.status, job.conclusion);
        const steps = (job.steps || [])
          .filter((step) => step.name && step.name !== "Set up job" && step.name !== "Complete job")
          .map((step) => {
            const stepClass = statusIcon(step.status, step.conclusion);
            return `<li class="${stepClass}"><span class="dot"></span>${escapeHtml(step.name)}</li>`;
          })
          .join("");
        return `
          <article class="job ${klass}">
            <header>
              <span class="dot"></span>
              <strong>${escapeHtml(job.name)}</strong>
              <em>${labelFor(job)}</em>
            </header>
            ${steps ? `<ul>${steps}</ul>` : ""}
          </article>
        `;
      })
      .join("");
  }

  function labelFor(item) {
    if (item.status === "completed" && item.conclusion === "success") return "concluído";
    if (item.status === "completed" && item.conclusion === "skipped") return "pulado";
    if (item.status === "completed") return "falhou";
    if (item.status === "in_progress") return "rodando";
    return "na fila";
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pollRun(runId) {
    const run = await api(`/repos/${cfg.repo}/actions/runs/${runId}`);
    const jobs = await api(`/repos/${cfg.repo}/actions/runs/${runId}/jobs?per_page=50`);
    renderJobs(jobs.jobs || [], run);
    if (run.html_url) {
      actionsLink.href = run.html_url;
      actionsLink.hidden = true;
    }
    if (run.status !== "completed") return false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (run.conclusion === "success") {
      setPhase("Coleta concluída", "O relatório já deve aparecer no site.");
      await revealReport(run.id);
    } else {
      setPhase("A coleta falhou", "Veja os jobs em vermelho para o detalhe.");
    }
    return true;
  }

  async function revealReport(githubRunId) {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const latest = await fetch(`${cfg.pagesUrl}latest.json?t=${Date.now()}`, {
          cache: "no-store",
        }).then((response) => (response.ok ? response.json() : null));
        if (latest && (!latest.github_run_id || String(latest.github_run_id) === String(githubRunId))) {
          reportLink.href = latest.url;
          actionsEl.hidden = false;
          return;
        }
        if (latest && latest.url) {
          reportLink.href = latest.url;
          actionsEl.hidden = false;
          return;
        }
      } catch {
        /* o Pages pode atrasar alguns segundos */
      }
      await sleep(3000);
    }
    reportLink.href = cfg.pagesUrl;
    actionsEl.hidden = false;
  }

  async function startCapture(file) {
    if (!token()) {
      setPhase("Coleta não configurada", "Peça ao time de automação para criar o secret COLETA_TOKEN.");
      hidePin();
      jobsEl.innerHTML = "";
      return;
    }
    hidePin();
    actionsEl.hidden = true;
    jobsEl.innerHTML = "";
    barEl.style.width = "8%";
    setPhase("Enviando planilha", file.name);
    try {
      await resetEntradaBranch();
      const sha = await uploadPlanilha(file);
      setPhase("Planilha enviada", "Esperando a Action iniciar…");
      barEl.style.width = "18%";
      const run = await waitForRun(sha);
      await pollRun(run.id);
      pollTimer = setInterval(() => {
        pollRun(run.id).catch((error) => {
          setPhase("Erro ao ler o progresso", error.message);
        });
      }, 4000);
    } catch (error) {
      setPhase("Não foi possível iniciar", error.message);
    }
  }

  function requestFile() {
    fileInput.value = "";
    fileInput.click();
  }

  openBtn?.addEventListener("click", () => {
    if (!token()) {
      openOverlay();
      hidePin();
      setPhase("Coleta não configurada", "Peça ao time de automação para criar o secret COLETA_TOKEN no repositório.");
      return;
    }
    if (needsPin()) {
      openOverlay();
      setPhase("Enviar planilha", "Digite o código da coleta para continuar.");
      showPin();
      return;
    }
    requestFile();
  });

  pinBtn?.addEventListener("click", () => {
    if ((pinInput.value || "").trim() === cfg.pin) {
      sessionStorage.setItem(TOKEN_KEY, "1");
      hidePin();
      requestFile();
      return;
    }
    pinError.hidden = false;
  });

  pinInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") pinBtn.click();
  });

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    selectedFile = file;
    openOverlay();
    startCapture(selectedFile);
  });

  closeBtn?.addEventListener("click", closeOverlay);
  overlay?.addEventListener("click", (event) => {
    if (event.target === overlay) closeOverlay();
  });
})();
