// Sheikcell CRM para Windows.
//
// O app abre https://crm.sheikcell.com.br dentro do WebView2. O próprio CRM
// (service worker + cache offline em IndexedDB) é quem faz a tela abrir rápido
// e funcionar com internet ruim ou sem internet — assim o desktop recebe toda
// atualização do CRM na hora, sem reinstalar.
//
// Segurança: nenhuma permissão (capability) do Tauri é concedida ao site
// remoto, então a página não tem acesso a arquivos nem comandos do Windows —
// ela roda isolada como num navegador comum.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Manager;

fn main() {
    tauri::Builder::default()
        // Clicar no ícone de novo só traz a janela aberta pra frente, em vez
        // de abrir uma segunda cópia (que derrubaria a sessão: limite de 2).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Sheikcell CRM");
}
