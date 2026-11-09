// store.js — guarda no aparelho (IndexedDB) as sessões com envio pendente,
// para retomar depois de queda de conexão ou se o navegador fechar a aba.
// Nada daqui sai do aparelho; é apagado quando o envio termina.

const DB_NAME = 'captura-frames';
const STORE = 'sessoes';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const st = t.objectStore(STORE);
    const req = fn(st);
    t.oncomplete = () => {
      db.close();
      resolve(req ? req.result : undefined);
    };
    t.onerror = () => {
      db.close();
      reject(t.error);
    };
  });
}

export async function saveSession(session) {
  try {
    await tx('readwrite', (st) => st.put(session));
    return true;
  } catch {
    return false; // navegação privada ou armazenamento cheio: segue sem persistir
  }
}

export async function listPending() {
  try {
    const all = await tx('readonly', (st) => st.getAll());
    return (all || []).filter((s) => s.status !== 'concluida').sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function deleteSession(id) {
  try {
    await tx('readwrite', (st) => st.delete(id));
  } catch {
    /* ignore */
  }
}
