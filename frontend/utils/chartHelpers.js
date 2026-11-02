// ============================================================
//  TerraWatch – Chart Helpers
// ============================================================

const CHART_DEFAULTS = {
  color: {
    accent:   '#00d8ff',
    critical: '#ff2d55',
    warning:  '#ffb300',
    info:     '#0090c8',
    safe:     '#00f5a0',
    grid:     'rgba(0,190,230,0.07)',
    text:     '#7ba8c4',
    purple:   '#c44dff',
    orange:   '#ff7043',
  }
};

function chartDefaults() {
  Chart.defaults.color       = CHART_DEFAULTS.color.text;
  Chart.defaults.borderColor = CHART_DEFAULTS.color.grid;
  Chart.defaults.font.family = "'JetBrains Mono', monospace";
  Chart.defaults.font.size   = 11;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.legend.labels.pointStyle    = 'circle';
  Chart.defaults.plugins.legend.labels.padding       = 16;
}

function riskColor(risk) {
  if (risk >= 7) return CHART_DEFAULTS.color.critical;
  if (risk >= 5) return '#ff6b35';
  if (risk >= 2) return CHART_DEFAULTS.color.warning;
  return CHART_DEFAULTS.color.safe;
}

function makeGradient(ctx, color) {
  const g = ctx.createLinearGradient(0, 0, 0, 280);
  g.addColorStop(0, color + '55');
  g.addColorStop(1, color + '00');
  return g;
}

// Generate mock trend data for fallback
function generateTrendData(days) {
  const labels = [];
  const pb = [], as = [], cd = [];
  for (let i = days; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    labels.push(d.toLocaleDateString('en', { month: 'short', day: 'numeric' }));
    pb.push(+(25 + Math.sin(i/3)*15 + Math.random()*8).toFixed(1));
    as.push(+(5  + Math.sin(i/4)*3  + Math.random()*2).toFixed(1));
    cd.push(+(0.6 + Math.sin(i/5)*0.4 + Math.random()*0.2).toFixed(2));
  }
  return { labels, pb, as, cd };
}
