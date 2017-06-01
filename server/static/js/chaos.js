/* eslint-disable no-mixed-operators */
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const fg = "#f3482d";

canvas.width = 400;
canvas.height = 200;

ctx.clearRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = fg;
ctx.font = "bold 100px arial";
ctx.textAlign = "center";
ctx.textBaseline = "middle";
ctx.fillText("CHAOS", canvas.width / 2, canvas.height / 2);

const charLocation = [];
const pixLocation = [];
let lastX = -1;
let lastY = -1;

for (let x = 0; x < canvas.width; x += 2) {
    for (let y = 0; y < canvas.height; y += 2) {
        if (ctx.getImageData(x, y, 1, 1).data[3] !== 0) {
            charLocation.push([x, y]);
            pixLocation.push([0, 0]);
        }
    }
}

canvas.onmousemove = (e) => {
    lastX = e.offsetX;
    lastY = e.offsetY;
};

function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = fg;
    for (let x = 0; x < pixLocation.length; x += 1) {
        const xPos = pixLocation[x][0] + 0.1 * (charLocation[x][0] - pixLocation[x][0]);
        let yPos = pixLocation[x][1] + 0.1 * (charLocation[x][1] - pixLocation[x][1]);
        if (lastX > 0 && lastY > 0) {
            const dx = pixLocation[x][0] - lastX;
            const dy = pixLocation[x][1] - lastY;
            if (Math.sqrt(dx * dx + dy * dy) < 10) {
                yPos = Math.random() > 0.5 ? 0 : canvas.height;
            }
        }
        pixLocation[x] = [xPos, yPos];
        ctx.fillRect(pixLocation[x][0], pixLocation[x][1], 2, 2);
    }
    lastX = -1;
    lastY = -1;
    window.requestAnimationFrame(loop);
}

window.requestAnimationFrame(loop);

const k = [38, 38, 40, 40, 37, 39, 37, 39, 66, 65];
let n = 0;
document.addEventListener("keydown", (e) => {
    n += 1;
    if (e.keyCode === k[n]) {
        if (n === k.length) {
            document.body.className = "transform";
            setTimeout(() => {
                document.body.className = "";
            }, 15000);
            n = 0;
            return false;
        }
    } else {
        n = 0;
    }
    return true;
});

function fade(element) {
    let op = 1; // initial opacity
    const elem = element;
    const timer = setInterval(() => {
        if (op <= 0.1) {
            clearInterval(timer);
            elem.style.display = "none";
        }
        elem.style.opacity = op;
        elem.style.filter = `alpha(opacity=${op * 100})`;
        op -= op * 0.1;
    }, 50);
}

function unfade(element) {
    let op = 0.1; // initial opacity
    const elem = element;
    elem.style.display = "block";
    const timer = setInterval(() => {
        if (op >= 1) {
            clearInterval(timer);
        }
        elem.style.opacity = op;
        elem.style.filter = `alpha(opacity=${op * 100})`;
        op += op * 0.1;
    }, 10);
}

const notification = document.getElementById("notifbox");
const notif = setTimeout(() => {
    notification.removeAttribute("hidden");
    notification.className += " fadeInDown";
    unfade(notification);
}, 5000);

// eslint-disable-next-line no-unused-vars
const dismissTimeout = () => {
    window.clearTimeout(notif);
};

// eslint-disable-next-line no-unused-vars
const dismissNotif = () => {
    notification.setAttribute("hidden", "true");
    fade(notification);
};

/** CHANGE CARD */

document.getElementById("voters").onclick = () => {
    document.getElementById("voters").classList.add("active");
    document.getElementById("main").classList.add("inactive");
    document.getElementById("main").classList.remove("active");
    document.getElementById("voters").classList.remove("inactive");
};

document.getElementById("main").onclick = () => {
    if (document.getElementById("main").classList.contains("inactive")) {
        document.getElementById("main").classList.add("active");
        document.getElementById("voters").classList.add("inactive");
        document.getElementById("voters").classList.remove("active");
        document.getElementById("main").classList.remove("inactive");
    }
};

/** LOAD VOTERS LIST */

const result = document.getElementById("result");
// read text from URL location
const request = new XMLHttpRequest();
request.open("GET", "voters.json", true);
request.send(null);
request.onreadystatechange = () => {
    if (request.readyState === 4 && request.status === 200) {
        const type = request.getResponseHeader("Content-Type");
        if (type.indexOf("text") !== 1) {
            const json = JSON.parse(request.responseText);
            const keys = Object.keys(json);
            const values = keys.map(key => json[key]);

            // combine arrays
            const list = [];
            for (let j = 0; j < keys.length; j += 1) {
                list.push({
                    names: keys[j],
                    votes: values[j],
                });
            }

            // eslint-disable-next-line no-nested-ternary
            list.sort((a, b) => -((a.votes < b.votes) ? -1 : ((a.votes === b.votes) ? 0 : 1)));

            let tablehtml = "<table>";
            for (let i = 0; i < list.length && i < 20; i += 1) {
                tablehtml += `<tr><td><a href="https://github.com/${escape(list[i].names)}">${list[i].names}</a></td><td>${list[i].votes}</tr>`;
            }
            tablehtml += "</table>";
            result.innerHTML = tablehtml;
        }
    }
};

let termLoading = false;

function loadTerm() {
    const script = document.createElement("script");
    script.onload = () => {
        // eslint-disable-next-line
        ($ && $.terminal && showTerminal) ? showTerminal() : null;
    };
    script.src = "static/js/term.js";
    document.body.appendChild(script);
}

function loadJqTE() {
    const script = document.createElement("script");
    script.onload = loadTerm;
    script.src = "https://cdnjs.cloudflare.com/ajax/libs/jquery.terminal/1.4.2/js/jquery.terminal.min.js";
    const sheet = document.createElement("link");
    sheet.rel = "stylesheet";
    sheet.href = "https://cdnjs.cloudflare.com/ajax/libs/jquery.terminal/1.4.2/css/jquery.terminal.min.css";
    document.body.appendChild(script);
    document.body.appendChild(sheet);
}

function loadJq() {
    termLoading = true;
    const script = document.createElement("script");
    script.onload = loadJqTE;
    script.src = "https://code.jquery.com/jquery-3.2.1.min.js";
    document.body.appendChild(script);
}

document.getElementById("term-load").onclick = () => {
    if (!termLoading) {
        loadJq();
    } else if (showTerminal) { // eslint-disable-line no-undef
        // eslint-disable-next-line no-undef
        showTerminal();
    }
};
