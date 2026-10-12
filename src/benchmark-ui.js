export function setupBenchmark(openDialog, onAnnounce) {
  const $ = id => document.getElementById(id);
  const format = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
  let report = null;
  let poll = null;
  let stopped = false;
  function render(job) {
    const running = job.status === 'running';
    $('benchmark-start').disabled = running;
    $('benchmark-cancel').hidden = !running;
    $('benchmark-progress').hidden = !running && job.status !== 'complete';
    for (const element of $('benchmark-form').querySelectorAll('select')) element.disabled = running;
    if (running) {
      $('benchmark-progress').max = job.games;
      $('benchmark-progress').value = job.done;
      const current = job.current ? `，当前局已消除 ${job.current.lines} 行` : '';
      $('benchmark-status').textContent = `已完成 ${job.done} / ${job.games} 局${current}。`;
      $('benchmark-result').hidden = true;
    } else if (job.status === 'complete') {
      report = job.report;
      $('benchmark-progress').value = report.games;
      $('benchmark-status').textContent = `评测完成，共 ${report.games} 局。`;
      $('benchmark-mean').textContent = format.format(report.meanLines);
      $('benchmark-median').textContent = format.format(report.medianLines);
      $('benchmark-completed').textContent = format.format(report.completed);
      $('benchmark-truncated').textContent = format.format(report.truncated);
      const interpretation = report.truncated ? '包含截断局，平均消行数是整局平均表现的下界。' : '所有局均自然结束。';
      const target = report.games === 200 && report.meanLines >= 1000 ? '本次 200 局观测平均达到 1000 行。' : '正式指标需要 200 局平均至少 1000 行。';
      $('benchmark-interpretation').textContent = `${interpretation}${target}`;
      $('benchmark-result').hidden = false;
      onAnnounce('AI 自动评测已完成。');
    } else if (job.status === 'error') $('benchmark-status').textContent = `评测失败：${job.error}。请检查 AI 服务后重试。`;
    else if (job.status === 'cancelled') $('benchmark-status').textContent = '评测已停止，未生成正式结果。';
  }
  async function refresh() {
    clearTimeout(poll);
    try {
      const response = await fetch('/api/evaluation');
      if (!response.ok) throw new Error('无法读取评测状态');
      const job = await response.json();
      render(job);
      if (job.status === 'running' && !stopped) poll = setTimeout(refresh, 1500);
    } catch (error) { $('benchmark-status').textContent = `${error.message}，请确认本地服务正在运行。`; }
  }
  $('benchmark-button').addEventListener('click', () => { stopped = false; openDialog('benchmark-dialog'); refresh(); });
  $('benchmark-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('benchmark-start').disabled = true;
    $('benchmark-status').textContent = '正在启动评测…';
    try {
      const response = await fetch('/api/evaluation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ games: Number($('benchmark-games').value), maxPieces: Number($('benchmark-limit').value), depth: Number($('benchmark-depth').value), provider: $('benchmark-provider').value }) });
      const job = await response.json();
      if (!response.ok) throw new Error(job.error || '无法启动评测');
      stopped = false;
      render(job);
      poll = setTimeout(refresh, 1000);
    } catch (error) { $('benchmark-status').textContent = `${error.message}，请检查服务后重试。`; $('benchmark-start').disabled = false; }
  });
  $('benchmark-cancel').addEventListener('click', async () => {
    stopped = true;
    clearTimeout(poll);
    try {
      const response = await fetch('/api/evaluation', { method: 'DELETE' });
      if (!response.ok) throw new Error('停止失败');
      render(await response.json());
    } catch (error) { $('benchmark-status').textContent = `${error.message}，请重试。`; stopped = false; poll = setTimeout(refresh, 1500); }
  });
  function download(extension, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `tetris-evaluation-${report.games}.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  $('download-json').addEventListener('click', () => { if (report) download('json', JSON.stringify(report, null, 2), 'application/json'); });
  $('download-csv').addEventListener('click', () => {
    if (!report) return;
    const keys = ['seed', 'lines', 'score', 'pieces', 'status', 'reason', 'decisions', 'meanDecisionMs', 'meanComputeMs', 'seconds'];
    download('csv', '\uFEFF' + [keys.join(','), ...report.records.map(record => keys.map(key => record[key]).join(','))].join('\n'), 'text/csv;charset=utf-8');
  });
}
