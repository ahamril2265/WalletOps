"use client";

import { useActionState, type ReactNode } from "react";
import { SubmitButton } from "./client";
import { buttonClass, cx } from "./ui";

type Message = { ok: boolean; message: string } | null;

function Result({ state }: { state: Message }) {
  if (!state) return null;
  return (
    <p className={cx("mt-2 rounded-lg px-3 py-2 text-sm", state.ok ? "bg-emerald-50 text-emerald-800" : "bg-rose-50 text-rose-800")} role="status">
      {state.message}
    </p>
  );
}

/** A button that runs a server action and shows the message it returns. */
export function ActionButton({
  action,
  children,
  variant = "secondary",
  pendingText,
  confirm,
  className,
}: {
  action: () => Promise<Message>;
  children: ReactNode;
  variant?: keyof typeof buttonClass;
  pendingText?: string;
  confirm?: string;
  className?: string;
}) {
  const [state, formAction] = useActionState(async () => action(), null);
  return (
    <form action={formAction} className={className}>
      <SubmitButton variant={variant} pendingText={pendingText} confirm={confirm}>
        {children}
      </SubmitButton>
      <Result state={state} />
    </form>
  );
}

/** A form whose fields are rendered by the server and whose server action returns a message. */
export function ActionForm({
  action,
  children,
  submitLabel,
  variant = "primary",
  pendingText,
  className,
}: {
  action: (prev: Message, formData: FormData) => Promise<Message>;
  children: ReactNode;
  submitLabel: string;
  variant?: keyof typeof buttonClass;
  pendingText?: string;
  className?: string;
}) {
  const [state, formAction] = useActionState(action, null);
  return (
    <form action={formAction} className={className}>
      {children}
      <div className="mt-4">
        <SubmitButton variant={variant} pendingText={pendingText}>
          {submitLabel}
        </SubmitButton>
      </div>
      <Result state={state} />
    </form>
  );
}
