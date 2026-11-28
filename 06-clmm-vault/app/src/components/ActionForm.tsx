import { useState } from "react";
import { formatAmount, parseAmount } from "../lib/amount";

export type Preview = { ok: true; text: string } | { ok: false; error: string };

interface Props {
  title: string;
  unit: string; // что вводим: TOKEN_A или shares
  decimals: number;
  max: bigint; // сколько есть у пользователя
  /** Что получит пользователь за `amount` (те же формулы, что в контракте) или почему контракт откажет. */
  preview: (amount: bigint) => Preview;
  /** Если задано — форма выключена, текст объясняет почему. */
  blockedReason?: string;
  busy: boolean;
  submitLabel: string;
  onSubmit: (amount: bigint) => Promise<boolean>;
}

export function ActionForm(p: Props) {
  const [text, setText] = useState("");

  let amount: bigint | null = null;
  let message = "";
  let bad = false;
  if (text.trim()) {
    try {
      amount = parseAmount(text, p.decimals);
      if (amount === 0n) [bad, message] = [true, "Сумма должна быть больше нуля"];
      else if (amount > p.max) [bad, message] = [true, `У вас только ${formatAmount(p.max, p.decimals)} ${p.unit}`];
      else {
        // контракт всё равно откажет — не отправляем пользователя подписывать зря
        const pv = p.preview(amount);
        [bad, message] = pv.ok ? [false, pv.text] : [true, pv.error];
      }
    } catch (e: any) {
      [bad, message] = [true, e.message];
    }
  }
  const blocked = !!p.blockedReason || p.busy;
  const ready = amount !== null && !bad && !blocked;

  return (
    <form
      className="action"
      onSubmit={async (e) => {
        e.preventDefault();
        if (ready && (await p.onSubmit(amount!))) setText("");
      }}
    >
      <h3>{p.title}</h3>
      <div className="row">
        <input
          inputMode="decimal"
          placeholder={`0 ${p.unit}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={blocked}
          aria-label={`${p.title}: сумма в ${p.unit}`}
        />
        <button
          type="button"
          className="ghost"
          disabled={blocked || p.max === 0n}
          onClick={() => setText(formatAmount(p.max, p.decimals))}
        >
          Макс
        </button>
      </div>
      <p className="hint">
        {p.blockedReason ??
          (message ? <span className={bad ? "bad" : ""}>{message}</span> : `Доступно: ${formatAmount(p.max, p.decimals)} ${p.unit}`)}
      </p>
      <button type="submit" disabled={!ready}>
        {p.busy ? "Ждём подтверждения…" : p.submitLabel}
      </button>
    </form>
  );
}
