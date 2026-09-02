let state;

const $ = selector => document.querySelector(selector);
const ballColors = {
  'glasses-cloth': ['#FFE0E5', '#F2778A', '#A63F53'],
  towel: ['#D9EEFF', '#5FA9E6', '#2F6FA7'],
  tumbler: ['#D7FAEF', '#58C9A5', '#27866C'],
  bandana: ['#FFD9D4', '#EB6659', '#A63A32'],
  'acrylic-keyring': ['#EEE0FF', '#9A72DB', '#6546A0'],
  'acrylic-clip': ['#FFE6C7', '#F3A24A', '#A96524'],
  sticker: ['#FFF2B8', '#E9C646', '#9B7C19'],
  squishy: ['#E3F6C6', '#89C95A', '#4F8D2D']
};

const svg = $('.figma-machine');
const drawArea = $('.draw-area');
const handle = $('#handle-rotor');
const rotor = $('#rotor');
const centerRotor = $('#center-rotor');
const ball = $('#ball');
const status = $('#status');
const modal = $('#modal');

let progress = 0;
let lastAngle = 0;
let dragging = false;
let completed = false;
let pendingDraw = null;
let activePointer = null;

function colorBall(id) {
  const colors = ballColors[id] || ['#FFF1B7', '#E0B65B', '#A97835'];
  ball.style.setProperty('--ball-light', colors[0]);
  ball.style.setProperty('--ball-mid', colors[1]);
  ball.style.setProperty('--ball-dark', colors[2]);
}

function render(data) {
  state = data;
  $('#items').innerHTML = data.items.map(item => {
    const soldOut = Number(item.remaining) <= 0;
    return '<article class="' + (soldOut ? 'sold-out' : '') + '"><span>' + item.name + '</span><strong>' +
      item.remaining.toLocaleString() + '<small>개</small></strong>' +
      (soldOut ? '<div class="sold-out-sticker">품절</div>' : '') + '</article>';
  }).join('');
}

async function load() {
  const response = await fetch('/api/public-state');
  render(await response.json());
}

const events = new EventSource('/api/public-events');
events.addEventListener('state', event => render(JSON.parse(event.data)));

function setRotation(degrees) {
  rotor.style.transform = 'rotate(' + degrees + 'deg)';
  centerRotor.style.transform = 'rotate(' + degrees + 'deg)';
  handle.style.transform = 'rotate(' + (degrees - 60) + 'deg)';
}

function pointerAngle(event) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return 0;
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const local = point.matrixTransform(matrix.inverse());
  return Math.atan2(local.y - 95, local.x - 107) * 180 / Math.PI;
}

async function reservePrize() {
  status.textContent = '상품을 확정하고 있어요…';
  try {
    const response = await fetch('/api/draw', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    colorBall(data.result.itemId);
    if (progress === 0) status.textContent = '시계 방향으로 두 바퀴 돌려주세요';
    return data;
  } catch (error) {
    progress = 0;
    completed = false;
    pendingDraw = null;
    setRotation(0);
    status.textContent = error.message;
    throw error;
  }
}

function startReservation() {
  if (!pendingDraw) {
    pendingDraw = reservePrize();
    pendingDraw.catch(() => {});
  }
  return pendingDraw;
}

function stopDragging(event) {
  if (!dragging) return;
  dragging = false;
  drawArea.classList.remove('is-dragging');
  if (activePointer !== null && handle.hasPointerCapture(activePointer)) {
    handle.releasePointerCapture(activePointer);
  }
  activePointer = null;
  if (!completed && progress > 0) {
    status.textContent = '계속 시계 방향으로 돌려주세요 · ' +
      (progress / 360).toFixed(1) + ' / 2바퀴';
  }
}

async function revealResult(drawId) {
  const response = await fetch('/api/reveal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drawId })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  render(data.state);
  return data.state;
}

function showLocalDecrement(itemId) {
  const fallback = {
    ...state,
    items: state.items.map(item =>
      item.id === itemId
        ? { ...item, remaining: Math.max(0, item.remaining - 1) }
        : item
    )
  };
  render(fallback);
  return fallback;
}

async function retryReveal(drawId, attempts = 0) {
  try {
    await revealResult(drawId);
  } catch (_) {
    if (attempts < 4) {
      setTimeout(() => retryReveal(drawId, attempts + 1), 1500 * (attempts + 1));
    }
  }
}

async function finishRound() {
  if (completed) return;
  completed = true;
  dragging = false;
  drawArea.classList.remove('is-dragging');
  progress = 720;
  setRotation(progress);
  status.textContent = '구슬이 나옵니다!';

  try {
    const data = await startReservation();
    ball.classList.remove('eject');
    void ball.offsetWidth;
    setTimeout(() => ball.classList.add('eject'), 100);
    setTimeout(async () => {
      let visibleState;
      try {
        visibleState = await revealResult(data.result.id);
      } catch (_) {
        visibleState = showLocalDecrement(data.result.itemId);
        retryReveal(data.result.id);
      }

      const item = visibleState.items.find(entry => entry.id === data.result.itemId);
      $('#prize').textContent = data.result.itemName;
      $('#left').textContent = '남은 수량 ' + item.remaining + '개';
      modal.hidden = false;
      status.textContent = '추첨이 완료됐어요';
    }, 1050);
  } catch (_) {
    completed = false;
  }
}
handle.addEventListener('pointerdown', event => {
  if (completed || event.button !== 0) return;
  event.preventDefault();
  dragging = true;
  activePointer = event.pointerId;
  lastAngle = pointerAngle(event);
  handle.setPointerCapture(event.pointerId);
  drawArea.classList.add('is-dragging');
  startReservation();
});

handle.addEventListener('pointermove', event => {
  if (!dragging || event.pointerId !== activePointer || completed) return;
  const angle = pointerAngle(event);
  const delta = ((angle - lastAngle + 540) % 360) - 180;
  lastAngle = angle;

  if (delta <= 0) return;

  progress = Math.min(720, progress + delta);
  setRotation(progress);
  status.textContent = '시계 방향으로 돌리는 중 · ' +
    (progress / 360).toFixed(1) + ' / 2바퀴';

  if (progress >= 720) finishRound();
});

handle.addEventListener('pointerup', stopDragging);
handle.addEventListener('pointercancel', stopDragging);

function resetRound() {
  modal.hidden = true;
  ball.classList.remove('eject');
  progress = 0;
  completed = false;
  pendingDraw = null;
  dragging = false;
  activePointer = null;
  drawArea.classList.remove('is-dragging');
  setRotation(0);
  status.textContent = '손잡이를 시계 방향으로 두 바퀴 돌려주세요';
}

$('#close').onclick = resetRound;
$('#again').onclick = resetRound;
document.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !modal.hidden) {
    event.preventDefault();
    resetRound();
  }
});
setRotation(0);
load();