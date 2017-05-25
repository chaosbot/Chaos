var canvas = document.createElement("canvas");
document.getElementsByClassName("content")[0].appendChild(canvas);
var ctx = canvas.getContext("2d");

canvas.width = 400;
canvas.height = 200;

ctx.fillStyle = "#000000";
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = "#ffffff";
ctx.font = "bold 100px arial";
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText("CHAOS", canvas.width/2, canvas.height/2);

var char_location = []
var pix_location = [];
var lastX = -1;
var lastY = -1;

for (x = 0; x < canvas.width; x += 2) {
  for (y = 0; y < canvas.height; y += 2) {
    if (ctx.getImageData(x, y, 1,1).data[0] == 255) {
      char_location.push([x,y]);
      pix_location.push([0,0]);
    }
  }
}

canvas.onmousemove = function(e) {
  lastX = e.offsetX;
  lastY = e.offsetY;
}

setInterval(function() {
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    for (x = 0; x < pix_location.length; x++) {
      var xPos = pix_location[x][0] + 0.1*(char_location[x][0]-pix_location[x][0]);
      var yPos = pix_location[x][1] + 0.1*(char_location[x][1]-pix_location[x][1]);
      if (lastX > 0 && lastY > 0) {
          dx = pix_location[x][0]-lastX;
          dy = pix_location[x][1]-lastY;
          if (Math.sqrt(dx*dx+dy*dy) < 10) {
            yPos = Math.random() > 0.5 ? 0 : canvas.height;
          }
      }
      pix_location[x] = [xPos,yPos];
      ctx.fillRect(pix_location[x][0], pix_location[x][1],2,2);
    }
    lastX = -1;
    lastY = -1;
}, 100);
