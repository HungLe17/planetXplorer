import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Bell, X } from "./icons";

type Notice = {id:string; read:boolean; archived?:string};
type Inbox = {
  mount: HTMLDivElement | null;
  setMount: (node: HTMLDivElement | null) => void;
  items: Notice[];
  opened: boolean;
  toggle: (value:boolean) => void;
  add: (id:string) => void;
  remove: (id:string, archive?:string) => void;
};
const Context = createContext<Inbox | null>(null);

export function NotificationCenter({children}:{children:ReactNode}) {
  const [mount,setMount] = useState<HTMLDivElement | null>(null);
  const [items,setItems] = useState<Notice[]>([]);
  const [opened,setOpened] = useState(false);
  const openRef = useRef(false);
  const toggle = (value:boolean) => {
    openRef.current = value;
    setOpened(value);
    if (value) setItems(old => old.map(item => ({...item,read:true})));
  };
  const add = useCallback((id:string) => {
    const read = openRef.current;
    setItems(old => [...old.filter(i => i.id !== id), {id,read}]);
  },[]);
  const remove = useCallback((id:string, archive?:string) => {
    setItems(old => {
      if (!archive) return old.filter(i => i.id !== id);
      const item = old.find(i => i.id === id);
      if (!item) return old;
      const recent = old.filter(i => i.id !== id && i.archived !== archive);
      const archived = recent.filter(i => i.archived).slice(-39);
      return [...recent.filter(i => !i.archived), ...archived, {...item,archived:archive}];
    });
  },[]);
  return <Context.Provider value={{mount,setMount,items,opened,toggle,add,remove}}>{children}</Context.Provider>;
}

export function NotificationBell() {
  const inbox = useContext(Context)!;
  const ref = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const unread = inbox.items.filter(i => !i.read).length;
  useEffect(() => {
    if (!inbox.opened) return;
    const close = (e:PointerEvent) => { if (!ref.current?.contains(e.target as Node)) inbox.toggle(false); };
    document.addEventListener("pointerdown",close);
    return () => document.removeEventListener("pointerdown",close);
  },[inbox.opened, inbox.toggle]);
  return <div className="notification-bell" ref={ref} onKeyDown={e => {
    if (e.key === "Escape" && inbox.opened) { e.stopPropagation(); inbox.toggle(false); button.current?.focus(); }
  }}>
    <button ref={button} type="button" className="button inbox-toggle" aria-label={`Notifications, ${unread} unread`}
      aria-expanded={inbox.opened} aria-controls="notification-inbox" onClick={() => inbox.toggle(!inbox.opened)}>
      <Bell size={17}/>{unread > 0 && <span className="unread-count" aria-hidden="true">{unread}</span>}
    </button>
    <section id="notification-inbox" aria-label="Notifications" className="notification-inbox" hidden={!inbox.opened}>
      <h2>Notifications</h2>
      {!inbox.items.length && <p>No notifications.</p>}
      <div ref={inbox.setMount}/>
      {inbox.items.filter(i => i.archived).map(item => <div className="dismissible-notice" key={item.id}>
        <p>{item.archived}</p><button type="button" className="notice-close" aria-label="Dismiss past notification"
          onClick={() => inbox.remove(item.id)}><X size={14}/></button></div>)}
    </section>
  </div>;
}

export default function Notification({ label, children, onDismiss }: {
  label: string; children: ReactNode; onDismiss?: () => void;
}) {
  const inbox = useContext(Context);
  const id = useId();
  const [dismissed,setDismissed] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const saved = useRef("");
  const add = inbox?.add, remove = inbox?.remove;
  const wasDismissed = useRef(false);
  useEffect(() => {
    if (body.current) saved.current = body.current.textContent?.trim() ?? "";
  });
  useEffect(() => {
    if (!add || !remove || dismissed) return;
    add(id);
    return () => remove(id, !wasDismissed.current && /error|warning|import notice/.test(label) ? saved.current : undefined);
  },[id,add,remove,dismissed,label]);
  if (dismissed) return null;
  const content = <div className="dismissible-notice">
    <div ref={body}>{children}</div>
    <button type="button" className="notice-close" aria-label={`Dismiss ${label}`} onClick={() => {
      wasDismissed.current = true; setDismissed(true); onDismiss?.();
    }}><X size={14}/></button>
  </div>;
  return inbox ? (inbox.mount && createPortal(content,inbox.mount)) : content;
}
