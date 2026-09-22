(() => {
  const cfg = window.COLETA || {};

  const $ = (id) => document.getElementById(id);
  const fileInput = $("coleta-file");
  const openBtn = $("btn-enviar-planilha");
  const overlay = $("coleta-overlay");
  const closeBtn = $("coleta-fechar");
  const titleEl = $("coleta-titulo");
  const subtitleEl = $("coleta-subtitulo");
  const stepEl = $("coleta-step");
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

  function setDetail(text) {
    stepEl.textContent = text || "";
  }

  function setProgress(percent) {
    barEl.style.width = `${Math.max(0, Math.min(100, Math.round(percent)))}%`;
  }

  function renderProgress(jobs, run) {
    const total = jobs.length || 1;
    const done = jobs.filter((job) => job.status === "completed").length;
    const running = jobs.find((job) => job.status === "in_progress");
    setProgress((done / total) * 100);
    setPhase(describeRun(run, running), run.display_title || "");
    setDetail(currentStep(jobs, running, done, total));
  }

  function currentStep(jobs, running, done, total) {
    const position = `${Math.min(done + (running ? 1 : 0), total)} de ${total} etapas`;
    if (!running) return position;
    const step = (running.steps || []).find((item) => item.status === "in_progress");
    return step ? `${position} · ${step.name}` : position;
  }

  function describeRun(run, running) {
    if (run.status === "queued") return "Na fila…";
    if (running) return `Em andamento: ${running.name}`;
    if (run.status !== "completed") return "Preparando a captura…";
    return run.conclusion === "success"
      ? "Coleta concluída"
      : "A coleta terminou com falha";
  }

  function failedJobs(jobs) {
    return jobs
      .filter((job) => job.status === "completed" && job.conclusion === "failure")
      .map((job) => job.name);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pollRun(runId) {
    const payload = await api(`/runs/${runId}`);
    const run = payload.run;
    const jobs = payload.jobs || [];
    renderProgress(jobs, run);
    if (run.status !== "completed") return false;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (run.conclusion === "success") {
      setProgress(92);
      setPhase("Publicando no GitHub Pages", "Falta só deixar o relatório no ar.");
      await revealReport(runId);
    } else {
      setProgress(100);
      const failed = failedJobs(jobs);
      setPhase("A coleta falhou", "Chame o time de qualidade com este horário.");
      setDetail(failed.length ? `Falhou em: ${failed.join(", ")}` : "");
    }
    return true;
  }

  async function revealReport(runId) {
    const deadline = Date.now() + 15 * 60 * 1000;
    let published = null;
    while (!published && Date.now() < deadline) {
      const latest = await readLatest();
      if (latest?.url && String(latest.github_run_id) === String(runId)) {
        published = latest;
        break;
      }
      const restante = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setDetail(`Aguardando o deploy do GitHub Pages… (${restante}s restantes)`);
      await sleep(5000);
    }

    setProgress(100);
    if (published) {
      reportLink.href = published.url;
      setPhase("Coleta concluída", "O relatório já está no ar.");
      setDetail("");
    } else {
      reportLink.href = cfg.pagesUrl;
      setPhase("Coleta concluída", "A publicação está demorando mais que o normal.");
      setDetail("Abra o site em alguns minutos para ver o relatório novo.");
    }
    actionsEl.hidden = false;
  }

  async function readLatest() {
    try {
      const response = await fetch(`${cfg.pagesUrl}latest.json?t=${Date.now()}`, {
        cache: "no-store",
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }

  async function startCapture(file) {
    actionsEl.hidden = true;
    setDetail("");
    setProgress(8);
    setPhase("Enviando planilha", file.name);
    try {
      const uploaded = await uploadPlanilha(file);
      setPhase("Planilha enviada", "Iniciando a captura…");
      setProgress(18);
      const run = await waitForRun(uploaded.sha);
      if (await pollRun(run.id)) return;
      pollTimer = setInterval(() => {
        pollRun(run.id).catch((error) => {
          setPhase("Erro ao ler o progresso", error.message);
        });
      }, 4000);
    } catch (error) {
      setProgress(100);
      setPhase("Não foi possível iniciar", error.message);
      setDetail("");
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
