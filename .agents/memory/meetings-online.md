---
name: Reuniões online
description: Sala de reunião (Jitsi) + gravação no navegador + Whisper/GPT gerando documentos
---
Reuniões da equipe vivem na área Documentos (`components/Reunioes.tsx` + `routes/meetings.ts`).

- Vídeo: iframe público meet.jit.si (sem chave); sala = roomCode `sheikcell-<tenant>-<uuid>`.
- Gravação no navegador: mic + áudio da aba (getDisplayMedia) mixados via AudioContext, opus 32kbps, MediaRecorder.
- **Limite de upload 20MB**: o express.json global aceita 30MB e o base64 infla ~33% — subir o limite da gravação exige subir o body limit junto, senão dá 413 antes da rota.
- Reunião `transcrita` não aceita nova gravação (evita pagar Whisper 2x); para regravar, criar outra reunião.
- Gravações em DOCS_DIR/meeting-recordings/<tenantId>/; documentos gerados (ata/resumo/tarefas via gpt-4o) entram na tabela documents como .txt.
- FE: a dona da gravação é fixada num ref ao apertar Gravar (não usar o estado openMeeting no onstop — usuário pode trocar de sala durante a transcrição).
