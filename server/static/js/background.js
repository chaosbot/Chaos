var img2 = new Image();
img2.src = "../static/assets/particle.png";

var background = document.getElementById("cv1"),
foreground1 = document.getElementById("cv2"),
foreground2 = document.getElementById("cv3"),
canvas_bg = document.querySelector("#bg").children,
config = {
	circle: {
		amount: 21,
		layer: 3,
		color: [0, 0, 0],
		alpha: 0.3
	},
	line: {
		amount: 15,
		layer: 3,
		color: [0, 255, 255],
		alpha: 0.3
	},
	speed: 0.5,
	angle: 20,
    get degree() {
        return this.angle/360*Math.PI*2
    }
};


if (background.getContext){
	var bctx = background.getContext('2d'),
	fctx1 = foreground1.getContext('2d'),
	fctx2 = foreground2.getContext('2d'),
	M = window.Math, // Cached Math
	circles = [],
	lines = [],
	wWidth, wHeight, timer, interval;
	
	requestAnimationFrame = window.requestAnimationFrame ||
	window.mozRequestAnimationFrame ||
	window.webkitRequestAnimationFrame ||
	window.msRequestAnimationFrame ||
	window.oRequestAnimationFrame ||
	function(callback, element) { setTimeout(callback, 1000 / 60); };
	
	cancelAnimationFrame = window.cancelAnimationFrame ||
	window.mozCancelAnimationFrame ||
	window.webkitCancelAnimationFrame ||
	window.msCancelAnimationFrame ||
	window.oCancelAnimationFrame ||
	clearTimeout;
	
	var setCanvasHeight = function(){
		
		wndsize = wndsize()
		wWidth = wndsize.width;
		wHeight = wndsize.height;
		for(var i = 0; canvas_bg.length > i ; i++){
			canvas_bg[i].width = wWidth;
			canvas_bg[i].height = wHeight;
		}
	};
	
	var drawCircle = function(x, y, radius, color, alpha){
		var gradient = fctx1.createRadialGradient(x, y, radius, x, y, 0);
		gradient.addColorStop(0, 'rgba('+color[0]+','+color[1]+','+color[2]+','+alpha+')');
		gradient.addColorStop(1, 'rgba('+color[0]+','+color[1]+','+color[2]+','+(alpha-0.1)+')');
		
		fctx1.beginPath();
		fctx1.arc(x, y, radius, 0, M.PI*2, true);
		fctx1.fillStyle = gradient;
		fctx1.fill();
	};
	
	var drawLine = function(x, y, width, color, alpha){
		var endX = x+M.sin(config.degree)*width,
		endY = y-M.cos(config.degree)*width,
		gradient = fctx2.createLinearGradient(x, y, endX, endY);
		gradient.addColorStop(0, 'rgba('+color[0]+','+color[1]+','+color[2]+','+alpha+')');
		gradient.addColorStop(1, 'rgba('+color[0]+','+color[1]+','+color[2]+','+(alpha-0.1)+')');
		
		fctx2.beginPath();
		fctx2.drawImage(img2,x,y,30,20);
		fctx2.moveTo(x, y);
		
		// fctx2.lineTo(endX, endY);
		// fctx2.lineWidth = 3;
		// fctx2.lineCap = 'round';
		// fctx2.strokeStyle = gradient;
		// fctx2.stroke();
	};
	
	var animate = function(){
		var sin = M.sin(config.degree),
		cos = M.cos(config.degree);
		
		if (config.circle.amount > 0 && config.circle.layer > 0){
			fctx1.clearRect(0, 0, wWidth, wHeight);
			for (var i=0, len = circles.length; i<len; i++){
				var item = circles[i],
				x = item.x,
				y = item.y,
				radius = item.radius,
				speed = item.speed;
				
				if (x > wWidth + radius){
					x = -radius;
				} else if (x < -radius){
					x = wWidth + radius
				} else {
					x += sin*speed;
				}
				
				if (y > wHeight + radius){
					y = -radius;
				} else if (y < -radius){
					y = wHeight + radius;
				} else {
					y -= cos*speed;
				}
				
				item.x = x;
				item.y = y;
				drawCircle(x, y, radius, item.color, item.alpha);
			}
		}
		
		if (config.line.amount > 0 && config.line.layer > 0){
			fctx2.clearRect(0, 0, wWidth, wHeight);
			for (var j=0, len = lines.length; j<len; j++){
				var item = lines[j],
				x = item.x,
				y = item.y,
				width = item.width,
				speed = item.speed;
				
				if (x > wWidth + width * sin){
					x = -width * sin;
				} else if (x < -width * sin){
					x = wWidth + width * sin;
				} else {
					x += sin*speed;
				}
				
				if (y > wHeight + width * cos){
					y = -width * cos;
				} else if (y < -width * cos){
					y = wHeight + width * cos;
				} else {
					y -= cos*speed;
				}
				
				item.x = x;
				item.y = y;
				drawLine(x, y, width, item.color, item.alpha);
			}
		}
		
		timer = requestAnimationFrame(animate);
	};
    
    var changeAngle = function(angle){
        console.debug("Starting a smoothed angle change...");
        if (interval) clearInterval(interval);
        let amt = 5;
        interval = setInterval(function(){
            let oldAngle = config.angle;
            if (config.angle < angle + amt && config.angle > angle - amt) {
                config.angle = angle;
                clearInterval(interval);
                console.debug("Smooth angle change complete.");
            } else if (config.angle > angle) {
                config.angle -= amt;
                console.debug("-5");
            } else {
                config.angle += amt;
                console.debug("+5");
            }
            console.debug(`Old angle: ${oldAngle}; Intended angle: ${angle}; New angle: ${config.angle}; Change: ${config.angle - oldAngle}`);
        }, 50);
    }
	
	var createItem = function(){
		circles = [];
		lines = [];
		
		if (config.circle.amount > 0 && config.circle.layer > 0){
			for (var i=0; i<config.circle.amount/config.circle.layer; i++){
				for (var j=0; j<config.circle.layer; j++){
					circles.push({
						x: M.random() * wWidth,
						y: M.random() * wHeight,
						radius: M.random()*(20+j*5)+(20+j*5),
						color: config.circle.color,
						alpha: M.random()*0.2+(config.circle.alpha-j*0.1),
						speed: config.speed*(1+j*0.5)
					});
				}
			}
		}
		
		if (config.line.amount > 0 && config.line.layer > 0){
			for (var m=0; m<config.line.amount/config.line.layer; m++){
				for (var n=0; n<config.line.layer; n++){
					lines.push({
						x: M.random() * wWidth,
						y: M.random() * wHeight,
						width: M.random()*(20+n*5)+(20+n*5),
						color: config.line.color,
						alpha: M.random()*0.2+(config.line.alpha-n*0.1),
						speed: config.speed*(1+n*0.5)
					});
				}
			}
		}
		
		cancelAnimationFrame(timer);
		timer = requestAnimationFrame(animate);
	};
	
	setCanvasHeight();
	createItem();
};

function wndsize(){
	var w = 0;var h = 0;
	if(!window.innerWidth){
		if(!(document.documentElement.clientWidth == 0)){
			w = document.documentElement.clientWidth;h = document.documentElement.clientHeight;
		} else{
			w = document.body.clientWidth;h = document.body.clientHeight;
		}
	} else {
		w = window.innerWidth;h = window.innerHeight;
	}
	return {width:w,height:h};	
}

document.onkeydown = function(event) {
    if (event.keyCode == 65) changeAngle(Math.round(Math.random() * 16 * 22.5) + 20);
}
