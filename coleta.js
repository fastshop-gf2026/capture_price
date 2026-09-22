(() => {
  const cfg = window.COLETA || {};

  const $ = (id) => document.getElementById(id);
  const fileInput = $("coleta-file");
  const openBtn = $("btn-enviar-planilha");
  const overlay = $("coleta-overlay");
  const closeBtn = $("coleta-fechar");
  const titleEl = $("coleta-titulo");
  const subtitleEl = $("coleta-subtitulo");
  const jobsEl = $("coleta-jobs");
  const barEl = $("coleta-bar");
  const actionsEl = $("coleta-acoes");
  const reportLink = $("coleta-relatorio");

  let pollTimer = null;

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

  async function api(path, options = {}) {
    if (!cfg.apiBase) {
      throw new Error("Serviço de coleta ainda não configurado.");
    }
    const response = await fetch(`${cfg.apiBase.replace(/\/$/, "")}${path}`, options);
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    if (!response.ok) {
      throw new Error(data.message || `Falha ${response.status}`);
    }
    return data;
  }

  async function uploadPlanilha(file) {
    const body = new FormData();
    body.append("planilha", file, file.name);
    return api("/capture", {
      method: "POST",
      body,
    });
  }

  async function waitForRun(headSha) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const payload = await api(`/runs/by-sha/${encodeURIComponent(headSha)}`);
      if (payload.run) return payload.run;
      await sleep(2000);
    }
    throw new Error("A captura ainda não iniciou. Tente de novo em alguns segundos.");
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

    const state = describeRun(run, running);
    setPhase(state, run.display_title || "");

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

  function describeRun(run, running) {
    if (run.status === "queued") return "Na fila…";
    if (running) return `Em andamento: ${running.name}`;
    if (run.status !== "completed") return "Preparando a captura…";
    return run.conclusion === "success"
      ? "Coleta concluída"
      : "A coleta terminou com falha";
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
    const payload = await api(`/runs/${runId}`);
    const run = payload.run;
    renderJobs(payload.jobs || [], run);
    if (run.status !== "completed") return false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (run.conclusion === "success") {
      setPhase("Coleta concluída", "O relatório já deve aparecer no site.");
      await revealReport();
    } else {
      setPhase("A coleta falhou", "Veja os itens em vermelho.");
    }
    return true;
  }

  async function revealReport() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const latest = await fetch(`${cfg.pagesUrl}latest.json?t=${Date.now()}`, {
          cache: "no-store",
        }).then((response) => (response.ok ? response.json() : null));
        if (latest?.url) {
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
    actionsEl.hidden = true;
    jobsEl.innerHTML = "";
    barEl.style.width = "8%";
    setPhase("Enviando planilha", file.name);
    try {
      const uploaded = await uploadPlanilha(file);
      setPhase("Planilha enviada", "Iniciando a captura…");
      barEl.style.width = "18%";
      const run = await waitForRun(uploaded.sha);
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

  openBtn?.addEventListener("click", () => {
    fileInput.value = "";
    fileInput.click();
  });

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    openOverlay();
    startCapture(file);
  });

  closeBtn?.addEventListener("click", closeOverlay);
  overlay?.addEventListener("click", (event) => {
    if (event.target === overlay) closeOverlay();
  });
})();
