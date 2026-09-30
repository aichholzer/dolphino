import React from "react";
import * as Primitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
export function Dialog({ open, onOpenChange, title, description, children }) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="dialog-overlay" />
        <Primitive.Content className="dialog-content">
          <Primitive.Title className="dialog-title">{title}</Primitive.Title>
          <Primitive.Description className="muted">
            {description}
          </Primitive.Description>
          <Primitive.Close className="dialog-close" aria-label="Close">
            <X size={19} />
          </Primitive.Close>
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
