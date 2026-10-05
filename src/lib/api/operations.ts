/**
 * Every public wallet operation, with its route and input schema. The HTTP route handlers and the
 * generator both go through `execute()`, so they get the same validation, error mapping,
 * idempotency and logging.
 */
import { z } from "zod";
import { createCustomer, getAccount, openAccount, setFrozen } from "../wallet/accounts";
import { CURRENCIES, MAX_AMOUNT_MINOR } from "../wallet/config";
import { deposit } from "../wallet/deposits";
import { NotFoundError } from "../wallet/errors";
import { getRates } from "../wallet/fx";
import { listAccountTransactions } from "../wallet/history";
import { refund } from "../wallet/refunds";
import { getTransaction, toView } from "../wallet/transactions";
import { transfer } from "../wallet/transfers";
import { withdraw } from "../wallet/withdrawals";

export const amountMinor = z.number().int().nonnegative().max(MAX_AMOUNT_MINOR);
const id = z.uuid();

/**
 * idempotencyKey: the Idempotency-Key header, if any.
 * synthetic: the request is generator test traffic (scenarios). Synthetic transfers skip fraud
 * screening and customer notifications, like test transactions in any real payment system.
 */
export type OperationContext = { idempotencyKey: string | null; synthetic: boolean };

type Operation<S extends z.ZodType> = {
  method: "GET" | "POST";
  route: string;
  schema: S;
  successStatus: number;
  /** Accepts an Idempotency-Key header. */
  idempotent: boolean;
  run: (input: z.infer<S>, ctx: OperationContext) => Promise<unknown>;
};

function op<S extends z.ZodType>(definition: Operation<S>): Operation<S> {
  return definition;
}

export const OPERATIONS = {
  "customers.create": op({
    method: "POST",
    route: "/api/v1/customers",
    schema: z.object({ name: z.string().trim().min(1).max(80), email: z.email().max(120) }),
    successStatus: 201,
    idempotent: false,
    run: (input) => createCustomer(input),
  }),
  "accounts.create": op({
    method: "POST",
    route: "/api/v1/accounts",
    schema: z.object({ customerId: id, currency: z.enum(CURRENCIES) }),
    successStatus: 201,
    idempotent: false,
    run: (input) => openAccount(input),
  }),
  "accounts.get": op({
    method: "GET",
    route: "/api/v1/accounts/:id",
    schema: z.object({ id }),
    successStatus: 200,
    idempotent: false,
    run: async (input) => {
      const account = await getAccount(input.id);
      if (account.kind !== "customer") throw new NotFoundError("Account", input.id);
      return account;
    },
  }),
  "accounts.freeze": op({
    method: "POST",
    route: "/api/v1/accounts/:id/freeze",
    schema: z.object({ id, frozen: z.boolean() }),
    successStatus: 200,
    idempotent: false,
    run: (input) => setFrozen(input.id, input.frozen),
  }),
  "accounts.transactions": op({
    method: "GET",
    route: "/api/v1/accounts/:id/transactions",
    schema: z.object({
      id,
      limit: z.coerce.number().int().min(1).max(100).default(20),
      cursor: z.string().regex(/^\d+$/).optional(),
    }),
    successStatus: 200,
    idempotent: false,
    run: (input) => listAccountTransactions(input.id, { limit: input.limit, cursor: input.cursor }),
  }),
  "deposits.create": op({
    method: "POST",
    route: "/api/v1/deposits",
    schema: z.object({ accountId: id, amountMinor }),
    successStatus: 201,
    idempotent: true,
    run: async (input, ctx) => toView(await deposit(input, ctx)),
  }),
  "withdrawals.create": op({
    method: "POST",
    route: "/api/v1/withdrawals",
    schema: z.object({ accountId: id, amountMinor }),
    successStatus: 201,
    idempotent: true,
    run: async (input, ctx) => toView(await withdraw(input, ctx)),
  }),
  "transfers.create": op({
    method: "POST",
    route: "/api/v1/transfers",
    schema: z.object({ fromAccountId: id, toAccountId: id, amountMinor }),
    successStatus: 201,
    idempotent: true,
    run: async (input, ctx) => toView(await transfer(input, ctx)),
  }),
  "refunds.create": op({
    method: "POST",
    route: "/api/v1/refunds",
    schema: z.object({ transactionId: id, amountMinor: amountMinor.optional() }),
    successStatus: 201,
    idempotent: true,
    run: async (input, ctx) => toView(await refund(input, ctx)),
  }),
  "transactions.get": op({
    method: "GET",
    route: "/api/v1/transactions/:id",
    schema: z.object({ id }),
    successStatus: 200,
    idempotent: false,
    run: async (input) => toView(await getTransaction(input.id)),
  }),
  "fx.rates": op({
    method: "GET",
    route: "/api/v1/fx-rates",
    schema: z.object({}),
    successStatus: 200,
    idempotent: false,
    run: async () => {
      const table = await getRates();
      return Object.fromEntries(
        Object.entries(table.rates).map(([currency, rate]) => [
          currency,
          { rateToUsd: rate, updatedAt: table.updatedAt[currency as keyof typeof table.updatedAt].toISOString() },
        ]),
      );
    },
  }),
};

export type OperationName = keyof typeof OPERATIONS;
export const OPERATION_NAMES = Object.keys(OPERATIONS) as OperationName[];
