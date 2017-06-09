// eslint-disable-next-line prefer-const
let prompt = "chaosbot-website > ";
let terminal;

$("#term").terminal({
    help: () => {
        terminal.echo("github, gitter, news, help");
    },
    github: () => {
        terminal.echo("<a href='https://github.com/chaosbot/Chaos'>Click here</a> to visit the GitHub repo.", { raw: true });
    },
    gitter: () => {
        terminal.echo("<a href='https://gitter.im/chaosthebot/Lobby'>Click here</a> to join the Gitter chat.", { raw: true });
    },
    news: () => {
        terminal.echo("<a href='http://anythingbot.org/video'>Click here</a> for a message from BWAA TV. Don't touch that dial! We'll be right back with more exciting programming news!", { raw: true });
    },

}, {
    enabled: false,
    greetings: "ChaosBot Terminal\n\nFor a list of available commands, type \"help\".",
    onCommandNotFound: (command, term) => term.echo(`Command ${command} not found!`),
    onInit: (term) => { terminal = term; },
    prompt: callback => callback(prompt),
});

// eslint-disable-next-line no-unused-vars
function showTerminal() {
    $("#term-modal").addClass("is-active");
    $("#term-modal").addClass("fade-in");
    terminal.enable();
    terminal.resize();
    setTimeout(() => {
        $("#term-modal").removeClass("fade-in");
    }, 500);
}

function hideTerminal() {
    $("#term-modal").addClass("fade-out");
    terminal.disable();
    setTimeout(() => {
        $("#term-modal").removeClass("is-active");
        $("#term-modal").removeClass("fade-out");
    }, 500);
}

$("#term-modal button.modal-close").on("click touch", () => hideTerminal());
