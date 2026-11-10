import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { actorKey, ddb, movieKey, type Role, tableName } from "../shared/db";
import { isResponse, parseJsonObject, response, serverError } from "../shared/http";
import Ajv from "ajv";
import schema from "../shared/types.schema.json"
import type { TransactionCanceledException } from "@aws-sdk/client-dynamodb";

// validator built from the role interfaces JSON schema (created with npm run schema)
const ajv = new Ajv();
const isValidRole = ajv.compile<Role>(schema);

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const body = parseJsonObject(event);
  if (isResponse(body)) return body;

  // reject bodies with missing, extra or wrongly typed fields
  if (!isValidRole(body)) {
    return response(400, {
      message: "Incorrect type. Must match the Role schema",
      schema: schema,
    });
  }
  const role: Role = body;

  try {
    // REQUIRED!!! role is only saved if every check passes
    await ddb.send(
      new TransactWriteCommand({
        TransactItems: [
          // requirement 1 - the movie must exist
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: movieKey(role.movieId), SK: movieKey(role.movieId) },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          // requirement 2 - the actor must exist (thought the Put would auto-add this, it did not after testing)
          {
            ConditionCheck: {
              TableName: tableName,
              Key: { PK: actorKey(role.actorId), SK: actorKey(role.actorId) },
              ConditionExpression: "attribute_exists(PK)",
            },
          },
          // requirement 3 - save the role with the single-table keys (m#movieID | a#actorID)
          {
            Put: {
              TableName: tableName,
              Item: { PK: movieKey(role.movieId), SK: actorKey(role.actorId), ...role },
              // dont overwrite a role the actor already has in a movie
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
        ],
      })
    );
    return response(201, { message: "Role added", data: role });
  } catch (err) {
    // a failed condition cancels the transaction and turns it into a clear status code
    if ((err as Error).name === "TransactionCanceledException") {
      return transactionErrorResponse(err as TransactionCanceledException, role);
    }
    return serverError(err);
  }
};

// CancellationReasons are in the same order as TransactItems.. it goes movie check -> actor check -> put
const transactionErrorResponse = (
  err: TransactionCanceledException,
  role: Role
): APIGatewayProxyResult => {
  const [movieMissing, actorMissing, roleExists] = (err.CancellationReasons ?? []).map(
    (reason) => reason.Code === "ConditionalCheckFailed"
  );
  if (roleExists) {
    return response(409, {
      message: `Actor ${role.actorId} already has a role in movie ${role.movieId}`,
    });
  }
  // report one of the two condition checks failed
  if (movieMissing) return response(404, {
    message: `Movie ${role.movieId} not found`
  });
  if (actorMissing) return response(404, {
    message: `Actor ${role.actorId} not found`
  });
  return serverError(err);
};
