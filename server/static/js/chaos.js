var canvas = document.getElementById("canvas");
var ctx = canvas.getContext("2d");
var fg = "#f3482d";

canvas.width = 400;
canvas.height = 200;

ctx.clearRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = fg;
ctx.font = "bold 100px arial";
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText("CHAOS", canvas.width / 2, canvas.height / 2);

var char_location = []
var pix_location = [];
var lastX = -1;
var lastY = -1;

for (x = 0; x < canvas.width; x += 2) {
  for (y = 0; y < canvas.height; y += 2) {
    if (ctx.getImageData(x, y, 1, 1).data[0] !== 0) {
      char_location.push([x, y]);
      pix_location.push([0, 0]);
    }
  }
}

canvas.onmousemove = function(e) {
  lastX = e.offsetX;
  lastY = e.offsetY;
}

function loop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = fg;
  for (x = 0; x < pix_location.length; x++) {
    var xPos = pix_location[x][0] + 0.1 * (char_location[x][0] - pix_location[x][0]);
    var yPos = pix_location[x][1] + 0.1 * (char_location[x][1] - pix_location[x][1]);
    if (lastX > 0 && lastY > 0) {
      dx = pix_location[x][0] - lastX;
      dy = pix_location[x][1] - lastY;
      if (Math.sqrt(dx * dx + dy * dy) < 10) {
        yPos = Math.random() > 0.5 ? 0 : canvas.height;
      }
    }
    pix_location[x] = [xPos, yPos];
    ctx.fillRect(pix_location[x][0], pix_location[x][1], 2, 2);
  }
  lastX = -1;
  lastY = -1;
  window.requestAnimationFrame(loop);
}

window.requestAnimationFrame(loop);

var k = [38, 38, 40, 40, 37, 39, 37, 39, 66, 65],
  n = 0;
document.addEventListener("keydown", function(e) {
  if (e.keyCode === k[n++]) {
    if (n === k.length) {
      document.body.className = 'transform';
      setTimeout(function() {
        document.body.className = '';
      }, 15000);
      n = 0;
      return false;
    }
  } else {
    n = 0;
  }
});

var notification = document.getElementById('notifbox');
var notif = setTimeout(function() {
  notification.removeAttribute('hidden');
  notification.className += " fadeInDown";
  unfade(notification);
}, 5000);

var dismissTimeout = function() {
  window.clearTimeout(notif);
};

var dismissNotif = function() {
  notification.setAttribute('hidden', 'true');
  fade(notification);
}

function fade(element) {
  var op = 1; // initial opacity
  var timer = setInterval(function() {
    if (op <= 0.1) {
      clearInterval(timer);
      element.style.display = 'none';
    }
    element.style.opacity = op;
    element.style.filter = 'alpha(opacity=' + op * 100 + ")";
    op -= op * 0.1;
  }, 50);
}

function unfade(element) {
  var op = 0.1; // initial opacity
  element.style.display = 'block';
  var timer = setInterval(function() {
    if (op >= 1) {
      clearInterval(timer);
    }
    element.style.opacity = op;
    element.style.filter = 'alpha(opacity=' + op * 100 + ")";
    op += op * 0.1;
  }, 10);
}