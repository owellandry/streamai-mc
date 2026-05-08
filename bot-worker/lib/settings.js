// Settings shim — provides Mindcraft-compatible settings for our bot
const mc_server = process.env.MC_SERVER || "localhost:25565";
const [mc_host, mc_port_str] = mc_server.split(":");
const settings = {
    minecraft_version: "1.21.1",
    host: mc_host || "localhost",
    port: parseInt(mc_port_str || "25565"),
    auth: "offline",
    allow_insecure_coding: false,
    code_timeout_mins: 10,
    max_commands: -1,
    verbose_commands: true,
    narrate_behavior: true,
    chat_bot_messages: true,
    block_place_delay: 100,
    show_bot_views: false,
};
export default settings;
