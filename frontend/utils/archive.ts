/**
 * 本地「成长档案」：把故事卡存进 IndexedDB。
 *
 * 为什么不直接下载：
 * - 语音指令/异步任务触发的 `<a download>` 没有用户手势，会被浏览器拦截；
 * - 故事卡是 Base64 大字符串，localStorage 几 MB 就会满，IndexedDB 更适合存图片。
 *
 * 数据只在本机，不上传；档案页里再显式点击下载。
 */

export interface ArchivedStoryCard {
  id: string
  dataUrl: string
  createdAt: number
  styleTitle: string
  caption: string
}

const DB_NAME = 'fingerprint-studio'
const DB_VERSION = 1
const STORE_NAME = 'story-cards'

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('当前浏览器不支持本地档案（IndexedDB）'))
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        store.createIndex('createdAt', 'createdAt')
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('打开本地档案失败'))
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('本地档案读写失败'))
  })
}

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** 存入一张故事卡；返回带 id/时间的记录，方便页面立即显示 */
export async function saveStoryCardToArchive(input: {
  dataUrl: string
  styleTitle: string
  caption: string
}): Promise<ArchivedStoryCard> {
  if (!input.dataUrl) throw new Error('故事卡内容为空')

  const card: ArchivedStoryCard = {
    id: createId(),
    dataUrl: input.dataUrl,
    createdAt: Date.now(),
    styleTitle: input.styleTitle.trim().slice(0, 40) || '自由创作',
    caption: input.caption.trim().slice(0, 200),
  }

  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(card)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('保存故事卡失败'))
      tx.onabort = () => reject(tx.error ?? new Error('保存故事卡被中止'))
    })
  }
  finally {
    db.close()
  }

  // 尽量让浏览器不要在空间紧张时清掉档案；不支持就算了，不阻塞保存。
  try {
    await navigator.storage?.persist?.()
  }
  catch {
    // 忽略：持久化授权不是保存成功的前提
  }

  return card
}

/** 按时间倒序列出全部故事卡 */
export async function listStoryCards(): Promise<ArchivedStoryCard[]> {
  const db = await openDatabase()
  try {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const cards = await requestResult(tx.objectStore(STORE_NAME).getAll() as IDBRequest<ArchivedStoryCard[]>)
    return cards.sort((a, b) => b.createdAt - a.createdAt)
  }
  finally {
    db.close()
  }
}

export async function deleteStoryCard(id: string): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('删除故事卡失败'))
      tx.onabort = () => reject(tx.error ?? new Error('删除故事卡被中止'))
    })
  }
  finally {
    db.close()
  }
}

/**
 * 清空整本本机档案。
 * 用 store.clear() 而不是 deleteDatabase()：其他标签页还开着时删除数据库会被 blocked，
 * 清空记录更可靠，也不会让当前页面拿到失效连接。
 */
export async function clearStoryCards(): Promise<void> {
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('清空故事卡失败'))
      tx.onabort = () => reject(tx.error ?? new Error('清空故事卡被中止'))
    })
  }
  finally {
    db.close()
  }
}

/**
 * 显式下载档案卡。
 * 只能在用户点击事件里调用；语音/异步路径请先存档案，再让用户来这里点。
 */
export function downloadStoryCard(card: Pick<ArchivedStoryCard, 'dataUrl' | 'createdAt'>) {
  const date = new Date(card.createdAt)
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const link = document.createElement('a')
  link.download = `指尖绘迹-故事卡-${stamp}.png`
  link.href = card.dataUrl
  document.body.appendChild(link)
  link.click()
  link.remove()
}
