"use client";

import { useRouter } from "next/navigation";
import { OrderForm } from "@/components/OrderForm";
import { useToast } from "@/components/Toast";
import { Card, PageHeader } from "@/components/ui";

export default function NewOrderPage() {
  const router = useRouter();
  const toast = useToast();

  return (
    <>
      <PageHeader title="New order" description="Create a manufacturing order" backHref="/orders" backLabel="Orders" />
      <Card className="max-w-3xl">
        <OrderForm
          onCancel={() => router.push("/orders")}
          onSaved={(order) => {
            toast("success", `Order ${order.order_number} created`);
            router.push(`/orders/${order.id}`);
          }}
        />
      </Card>
    </>
  );
}
