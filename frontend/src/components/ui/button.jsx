import React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva } from 'class-variance-authority';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
export const cn = (...inputs) => twMerge(clsx(inputs));

// default: the main action of a page, form or dialog; Add actions carry a Plus icon and sit right in the toolbar.
// outline: every other action, including item actions on cards, rows and tables. ghost: icon-only buttons.
// One size and one padding for every text button.
const variants = cva('button', {
  variants: {
    variant: {
      default: 'button-primary',
      outline: 'button-outline',
      ghost: 'button-ghost',
      destructive: 'button-danger'
    },
    size: { default: '', icon: 'button-icon' }
  },
  defaultVariants: { variant: 'default', size: 'default' }
});
export const Button = React.forwardRef(({ className, variant, size, asChild = false, ...props }, ref) => {
  const Comp = asChild ? Slot : 'button';
  return <Comp ref={ref} className={cn(variants({ variant, size }), className)} {...props} />;
});

Button.displayName = 'Button';
