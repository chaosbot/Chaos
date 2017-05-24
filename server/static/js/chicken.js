var xpos = 100;
var ypos = 100;
var oldxpos = xpos;
var oldypos = ypos;
var xspeed = 1;
var yspeed = 0;
var maxSpeed = 50;
var minx = 0;
var miny = 0;
var myWidth = 0, myHeight = 0;
if( typeof( window.innerWidth ) == 'number' ) {
  //Non-IE
  myWidth = window.innerWidth;
  myHeight = window.innerHeight;
} else if( document.documentElement && ( document.documentElement.clientWidth || document.documentElement.clientHeight ) ) {
  //IE 6+ in 'standards compliant mode'
  myWidth = document.documentElement.clientWidth;
  myHeight = document.documentElement.clientHeight;
} else if( document.body && ( document.body.clientWidth || document.body.clientHeight ) ) {
  //IE 4 compatible
  myWidth = document.body.clientWidth;
  myHeight = document.body.clientHeight;
}
var maxx = myWidth - 99;
var maxy = myHeight - 133;
var upPressed = 0;
var downPressed = 0;
var leftPressed = 0;
var rightPressed = 0;

function slowDownX() {
  if (xspeed > 0)
    xspeed = xspeed - 1;
  if (xspeed < 0)
    xspeed = xspeed + 1;
}

function slowDownY() {
  if (yspeed > 0)
    yspeed = yspeed - 1;
  if (yspeed < 0)
    yspeed = yspeed + 1;
}

function gameLoop() {
  xpos += xspeed;
  ypos += yspeed;
  if (xpos < minx) {
    xpos = minx;
    xspeed = -xspeed;
  } else if (xpos > maxx) {
    xpos = maxx;
    xspeed = -xspeed;
  }
  if (ypos < miny) {
    ypos = miny;
    yspeed = -yspeed;
  } else if (ypos > maxy) {
    ypos = maxy;
    yspeed = -yspeed;
  }
  document.getElementById('chicken').style.left = xpos + "px";
  document.getElementById('chicken').style.top = ypos + "px";

  // change speed based on keyboard events
  if (upPressed == 1)
    yspeed = Math.max(yspeed - 1,-1*maxSpeed);
  if (downPressed == 1)
    yspeed = Math.min(yspeed + 1,1*maxSpeed)
  if (rightPressed == 1)
    xspeed = Math.min(xspeed + 1,1*maxSpeed);
  if (leftPressed == 1)
    xspeed = Math.max(xspeed - 1,-1*maxSpeed);

  // deceleration
  if (upPressed == 0 && downPressed == 0)
     slowDownY();
  if (leftPressed == 0 && rightPressed == 0)
     slowDownX();

  // loop
  setTimeout("gameLoop()", 10);
}

function keyDown(e) {
  var code = e.keyCode ? e.keyCode : e.which;
  if (code == 38)
    upPressed = 1;
  if (code == 40)
    downPressed = 1;
  if (code == 37)
    leftPressed = 1;
  if (code == 39)
    rightPressed = 1;
}

function keyUp(e) {
  var code = e.keyCode ? e.keyCode : e.which;
  if (code == 38)
    upPressed = 0;
  if (code == 40)
    downPressed = 0;
  if (code == 37)
    leftPressed = 0;
  if (code == 39)
    rightPressed = 0;
}
