import { useEffect, useState } from 'react'
import { Dashboard } from './components/Dashboard'
import { ComparisonEditor, DataManager, LaborEditor, MenuEditor, OperationsEditor, ProcessesEditor, ResourcesEditor, UtilitiesEditor } from './components/Editors'
import { InventoryEditor } from './components/InventoryEditor'
import { Icon, type IconName } from './components/ui'
import { createSampleSettings } from './data/sampleData'
import type { AppSettings, PeriodKey } from './models/types'
import { loadSettings, parseSettingsJson, saveSettings } from './storage/settingsStorage'

type PageKey = 'dashboard' | 'operations' | 'menus' | 'resources' | 'processes' | 'inventory' | 'labor' | 'utilities' | 'comparison' | 'data'

const navItems: { id: PageKey; label: string; caption: string; icon: IconName }[] = [
  { id: 'dashboard', label: 'ダッシュボード', caption: '主要KPI', icon: 'dashboard' },
  { id: 'operations', label: '営業条件', caption: '食数・時間・日数', icon: 'store' },
  { id: 'menus', label: 'メニュー', caption: '価格・構成比', icon: 'menu' },
  { id: 'resources', label: '原材料', caption: '仕入・歩留まり', icon: 'box' },
  { id: 'processes', label: '仕込み / レシピ', caption: 'Input → Output', icon: 'recipe' },
  { id: 'inventory', label: '在庫・仕入', caption: 'FIFO・購入支出', icon: 'box' },
  { id: 'labor', label: '人件費', caption: '役割・実作業', icon: 'labor' },
  { id: 'utilities', label: '光熱費・設備', caption: '水道・ガス・電気・油', icon: 'utility' },
  { id: 'comparison', label: '内製 vs 既製品', caption: 'ROI・シナリオ', icon: 'compare' },
  { id: 'data', label: 'データ管理', caption: '保存・JSON', icon: 'data' },
]

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [activePage, setActivePage] = useState<PageKey>('dashboard')
  const [period, setPeriod] = useState<PeriodKey>('month')
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [dataMessage, setDataMessage] = useState<{ type: 'success' | 'error'; text: string }>()

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      saveSettings(settings)
      setSavedAt(new Date())
    }, 250)
    return () => window.clearTimeout(timeout)
  }, [settings])

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `sobaops-settings-${new Date().toISOString().slice(0, 10)}.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setDataMessage({ type: 'success', text: '設定JSONを書き出しました。' })
  }

  const importJson = async (file: File) => {
    try {
      const imported = parseSettingsJson(await file.text())
      setSettings(imported)
      setDataMessage({ type: 'success', text: `${file.name} を読み込みました。` })
    } catch (error) {
      setDataMessage({ type: 'error', text: error instanceof Error ? error.message : '設定を読み込めませんでした。' })
    }
  }

  const reset = () => {
    if (!window.confirm('現在の設定を破棄して、サンプル店舗の初期値へ戻しますか？')) return
    setSettings(createSampleSettings())
    setDataMessage({ type: 'success', text: 'サンプル店舗の初期値を復元しました。' })
  }

  const renderPage = () => {
    const common = { settings, onChange: setSettings }
    switch (activePage) {
      case 'operations': return <OperationsEditor {...common} />
      case 'menus': return <MenuEditor {...common} />
      case 'resources': return <ResourcesEditor {...common} />
      case 'processes': return <ProcessesEditor {...common} />
      case 'inventory': return <InventoryEditor {...common} />
      case 'labor': return <LaborEditor {...common} />
      case 'utilities': return <UtilitiesEditor {...common} />
      case 'comparison': return <ComparisonEditor {...common} />
      case 'data': return <DataManager {...common} onExport={exportJson} onImport={importJson} onReset={reset} message={dataMessage} />
      default: return <Dashboard settings={settings} period={period} onPeriodChange={setPeriod} />
    }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <button className="brand" onClick={() => setActivePage('dashboard')}>
        <span className="brand-mark"><i/><i/><i/></span>
        <span><strong>SobaOps</strong><small>蕎麦店オペレーション分析</small></span>
      </button>
      <div className="sidebar-section-label">WORKSPACE</div>
      <nav>
        {navItems.map((item) => <button key={item.id} className={activePage === item.id ? 'active' : ''} onClick={() => setActivePage(item.id)}>
          <span className="nav-icon"><Icon name={item.icon} size={19}/></span><span><b>{item.label}</b><small>{item.caption}</small></span>
        </button>)}
      </nav>
      <div className="sidebar-footer">
        <div className="save-status"><i/><span><b>自動保存</b><small>{savedAt ? `${savedAt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })} に保存` : '準備中'}</small></span></div>
        <p>schema v{settings.schemaVersion} · browser only</p>
      </div>
    </aside>
    <div className="workspace">
      <header className="mobile-header">
        <button className="brand" onClick={() => setActivePage('dashboard')}><span className="brand-mark"><i/><i/><i/></span><span><strong>SobaOps</strong><small>蕎麦店運営分析</small></span></button>
        <select aria-label="表示画面" value={activePage} onChange={(event) => setActivePage(event.target.value as PageKey)}>{navItems.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select>
      </header>
      <main>{renderPage()}</main>
      <footer className="app-footer"><span>SobaOps Phase 3</span><span>簡易現金収支は正式な会計CFではありません。実際の仕入・請求・勤務実績と照合してください。</span></footer>
    </div>
  </div>
}
