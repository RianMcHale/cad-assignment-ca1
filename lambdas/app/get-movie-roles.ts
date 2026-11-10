import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  ddb,
  isRoleItem,
  movieKey,
  isMovieItem,
  parseId,
  tableName,
  toRole,
} from "../shared/db";
import { response, serverError } from "../shared/http";
import { logRequest } from "../shared/request-logger";


export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  logRequest(event);

  const movieId = parseId(event.pathParameters?.movieID);
  if (movieId === undefined) {
    return response(400, { message: "movieID must be a positive integer" });
  }

  // check the optional ?actor value is a valid Id before querying
  const actorParam = event.queryStringParameters?.actor;
  const actorId = parseId(actorParam);
  if (actorParam !== undefined && actorId === undefined) {
    return response(400, { message: "actor must be a positive integer" });
  }
  try {
    // get the movie and all its roles to handle paging
    const resultItems = await getMovieItems(movieId);

    // the movie item shares the partition with its roles so no movie item means its an unknown movie
    if (!resultItems.some(isMovieItem)) {
      return response(404, { message: `Movie $(movieId) not found` });
    }
    let roles = resultItems.filter(isRoleItem).map(toRole);
    // if actor was give n keep that actors role in the movie
    if (actorId !== undefined) {
      roles = roles.filter((role) => role.actorId === actorId);

      // the actor ID is valid but they have no role in this movie
      if (roles.length === 0) {
        return response(404, { message: `Actor ${actorId} has no role in movie ${movieId}` });
      }
    }
    return response(200, { data: roles });

  } catch (err) {
    return serverError(err);
  }
};

    // returns every item in the movies partition (movie and the roles)
    // has LastEvaluatedKey at the end in case the results are mroe than one page in length
    const getMovieItems = async (movieId: number) => {
      const items: Record<string, any>[] = [];
      let lastKey: Record<string, any> | undefined;
      do {
        const page = await ddb.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": movieKey(movieId) },
            ExclusiveStartKey: lastKey,
          })
        );
        items.push(...(page.Items ?? []));
        lastKey = page.LastEvaluatedKey;
      } while (lastKey);
      return items;
    };