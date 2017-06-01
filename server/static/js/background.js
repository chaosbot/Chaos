const img2 = new Image();
img2.src = "../static/assets/particle.png";

const background = document.getElementById("cv1");
const foreground1 = document.getElementById("cv2");
const foreground2 = document.getElementById("cv3");
const canvasBg = document.querySelector("#bg").children;
const config = {
    circle: {
        amount: 21,
        layer: 3,
        color: [0, 0, 0],
        alpha: 0.3,
    },
    line: {
        amount: 15,
        layer: 3,
        color: [0, 255, 255],
        alpha: 0.3,
    },
    speed: 0.5,
    angle: 20,
    get degree() {
        return this.angle / 360 * Math.PI * 2;
    },
};

let changeAngle;

function getWndSize() {
    let w = 0;
    let h = 0;
    if (!window.innerWidth) {
        if (!(document.documentElement.clientWidth === 0)) {
            w = document.documentElement.clientWidth;
            h = document.documentElement.clientHeight;
        } else {
            w = document.body.clientWidth;
            h = document.body.clientHeight;
        }
    } else {
        w = window.innerWidth;
        h = window.innerHeight;
    }
    return {
        width: w,
        height: h,
    };
}

if (background.getContext) {
    const fctx1 = foreground1.getContext("2d");
    const fctx2 = foreground2.getContext("2d");
    const M = window.Math; // Cached Math
    let circles = [];
    let lines = [];
    let wWidth;
    let wHeight;
    let timer;
    let interval;

    // eslint-disable-next-line no-global-assign
    requestAnimationFrame = window.requestAnimationFrame ||
        window.mozRequestAnimationFrame ||
        window.webkitRequestAnimationFrame ||
        window.msRequestAnimationFrame ||
        window.oRequestAnimationFrame ||
        (callback => setTimeout(callback, 1000 / 60));

    // eslint-disable-next-line no-global-assign
    cancelAnimationFrame = window.cancelAnimationFrame ||
        window.mozCancelAnimationFrame ||
        window.webkitCancelAnimationFrame ||
        window.msCancelAnimationFrame ||
        window.oCancelAnimationFrame ||
        clearTimeout;

    const setCanvasHeight = () => {
        const wndsize = getWndSize();
        wWidth = wndsize.width;
        wHeight = wndsize.height;
        for (let i = 0; canvasBg.length > i; i += 1) {
            canvasBg[i].width = wWidth;
            canvasBg[i].height = wHeight;
        }
    };

    const drawCircle = (x, y, radius, color, alpha) => {
        const gradient = fctx1.createRadialGradient(x, y, radius, x, y, 0);
        gradient.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${alpha})`);
        gradient.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},${alpha - 0.1})`);

        fctx1.beginPath();
        fctx1.arc(x, y, radius, 0, M.PI * 2, true);
        fctx1.fillStyle = gradient;
        fctx1.fill();
    };

    const drawLine = (x, y, width, color, alpha) => {
        const endX = x + M.sin(config.degree) * width;
        const endY = y - M.cos(config.degree) * width;
        const gradient = fctx2.createLinearGradient(x, y, endX, endY);
        gradient.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${alpha})`);
        gradient.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},${alpha - 0.1})`);

        fctx2.beginPath();
        fctx2.drawImage(img2, x, y, 30, 20);
        fctx2.moveTo(x, y);

        // fctx2.lineTo(endX, endY);
        // fctx2.lineWidth = 3;
        // fctx2.lineCap = 'round';
        // fctx2.strokeStyle = gradient;
        // fctx2.stroke();
    };

    const animate = () => {
        const sin = M.sin(config.degree);
        const cos = M.cos(config.degree);

        if (config.circle.amount > 0 && config.circle.layer > 0) {
            fctx1.clearRect(0, 0, wWidth, wHeight);
            for (let i = 0, len = circles.length; i < len; i += 1) {
                const item = circles[i];
                let x = item.x;
                let y = item.y;
                const radius = item.radius;
                const speed = item.speed;

                if (x > wWidth + radius) {
                    x = -radius;
                } else if (x < -radius) {
                    x = wWidth + radius;
                } else {
                    x += sin * speed;
                }

                if (y > wHeight + radius) {
                    y = -radius;
                } else if (y < -radius) {
                    y = wHeight + radius;
                } else {
                    y -= cos * speed;
                }

                item.x = x;
                item.y = y;
                drawCircle(x, y, radius, item.color, item.alpha);
            }
        }

        if (config.line.amount > 0 && config.line.layer > 0) {
            fctx2.clearRect(0, 0, wWidth, wHeight);
            for (let j = 0, len = lines.length; j < len; j += 1) {
                const item = lines[j];
                let x = item.x;
                let y = item.y;
                const width = item.width;
                const speed = item.speed;

                if (x > wWidth + width * sin) {
                    x = -width * sin;
                } else if (x < -width * sin) {
                    x = wWidth + width * sin;
                } else {
                    x += sin * speed;
                }

                if (y > wHeight + width * cos) {
                    y = -width * cos;
                } else if (y < -width * cos) {
                    y = wHeight + width * cos;
                } else {
                    y -= cos * speed;
                }

                item.x = x;
                item.y = y;
                drawLine(x, y, width, item.color, item.alpha);
            }
        }

        timer = requestAnimationFrame(animate);
    };

    // eslint-disable-next-line no-unused-vars
    changeAngle = (angle) => {
        console.debug("Starting a smoothed angle change...");
        if (interval) clearInterval(interval);
        const amt = 5;
        interval = setInterval(() => {
            const oldAngle = config.angle;
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
    };

    const createItem = () => {
        circles = [];
        lines = [];

        if (config.circle.amount > 0 && config.circle.layer > 0) {
            for (let i = 0; i < config.circle.amount / config.circle.layer; i += 1) {
                for (let j = 0; j < config.circle.layer; j += 1) {
                    circles.push({
                        x: M.random() * wWidth,
                        y: M.random() * wHeight,
                        radius: M.random() * (20 + j * 5) + (20 + j * 5),
                        color: config.circle.color,
                        alpha: M.random() * 0.2 + (config.circle.alpha - j * 0.1),
                        speed: config.speed * (1 + j * 0.5),
                    });
                }
            }
        }

        if (config.line.amount > 0 && config.line.layer > 0) {
            for (let m = 0; m < config.line.amount / config.line.layer; m += 1) {
                for (let n = 0; n < config.line.layer; n += 1) {
                    lines.push({
                        x: M.random() * wWidth,
                        y: M.random() * wHeight,
                        width: M.random() * (20 + n * 5) + (20 + n * 5),
                        color: config.line.color,
                        alpha: M.random() * 0.2 + (config.line.alpha - n * 0.1),
                        speed: config.speed * (1 + n * 0.5),
                    });
                }
            }
        }

        cancelAnimationFrame(timer);
        timer = requestAnimationFrame(animate);
    };

    setCanvasHeight();
    createItem();
}

document.onkeydown = (event) => {
    if (event.keyCode === 65) changeAngle(Math.round(Math.random() * 16 * 22.5) + 20);
};
