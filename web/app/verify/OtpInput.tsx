"use client"

import { forwardRef, useImperativeHandle, useRef } from "react"

/**
 * The 6-box OTP input, ported from the .otp-box handlers in verify/app.js:
 * type-through-advance, backspace-to-previous, arrow-key navigation, and
 * bulk-fill from both autofill (an input event with >1 digit) and an explicit
 * paste. Boxes are uncontrolled — read directly from the DOM via `getValue()`
 * — matching the legacy page's direct `.value` manipulation and avoiding a
 * re-render per keystroke.
 */
const LENGTH = 6

export interface OtpInputHandle {
  getValue: () => string
  clear: () => void
  focus: () => void
}

const OtpInput = forwardRef<OtpInputHandle>(function OtpInput(_props, ref) {
  const boxes = useRef<Array<HTMLInputElement | null>>([])

  useImperativeHandle(ref, () => ({
    getValue: () => boxes.current.map((box) => box?.value ?? "").join(""),
    clear: () => {
      for (const box of boxes.current) {
        if (box) box.value = ""
      }
    },
    focus: () => {
      boxes.current[0]?.focus()
    },
  }))

  const handleInput = (i: number) => (e: React.FormEvent<HTMLInputElement>) => {
    const box = e.currentTarget
    const digits = box.value.replace(/\D/g, "")
    if (digits.length > 1) {
      for (let k = 0; k < digits.length && i + k < LENGTH; k++) {
        const target = boxes.current[i + k]
        if (target) target.value = digits[k]!
      }
      boxes.current[Math.min(i + digits.length, LENGTH - 1)]?.focus()
    } else {
      box.value = digits
      if (digits && i < LENGTH - 1) boxes.current[i + 1]?.focus()
    }
  }

  const handleKeyDown = (i: number) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    const box = e.currentTarget
    if (e.key === "Backspace" && !box.value && i > 0) {
      e.preventDefault()
      const prev = boxes.current[i - 1]
      if (prev) {
        prev.value = ""
        prev.focus()
      }
    } else if (e.key === "ArrowLeft" && i > 0) {
      e.preventDefault()
      boxes.current[i - 1]?.focus()
    } else if (e.key === "ArrowRight" && i < LENGTH - 1) {
      e.preventDefault()
      boxes.current[i + 1]?.focus()
    }
  }

  const handlePaste = (i: number) => (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    const text = e.clipboardData.getData("text")
    const digits = text.replace(/\D/g, "").slice(0, LENGTH - i)
    for (let k = 0; k < digits.length; k++) {
      const target = boxes.current[i + k]
      if (target) target.value = digits[k]!
    }
    if (digits.length) boxes.current[Math.min(i + digits.length, LENGTH - 1)]?.focus()
  }

  return (
    <div role="group" aria-labelledby="otp-label" className="flex gap-2">
      {Array.from({ length: LENGTH }, (_, i) => (
        <input
          key={i}
          ref={(el) => {
            boxes.current[i] = el
          }}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`หลักที่ ${i + 1}`}
          onInput={handleInput(i)}
          onKeyDown={handleKeyDown(i)}
          onPaste={handlePaste(i)}
          className="aspect-square min-w-0 flex-1 rounded-[var(--radius-card)] border border-[var(--color-line)] bg-white text-center text-2xl font-bold text-[var(--color-ink)] focus:border-[var(--color-primary)] focus:outline-none"
        />
      ))}
    </div>
  )
})

export default OtpInput
