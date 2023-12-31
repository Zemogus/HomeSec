/* Expected event body: {
 *     "action": "add-device",
 *     "data": string,
 * }
 */

"use strict";
import { randomBytes } from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
    DynamoDBDocumentClient,
    GetCommand,
    UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));

/**
 * @param {string} connectionId
 * @returns {Promise<string | null>}
 */
async function getUsername(connectionId) {
    const data = await dynamo.send(
        new GetCommand({
            TableName: process.env.CONNECTION_TABLE,
            Key: {
                id: connectionId,
            },
            ProjectionExpression: "username",
        })
    );

    return data.Item?.username ?? null;
}

/**
 * @param {string} username
 * @param {string} deviceId
 * @param {string} name
 */
async function addDevice(username, deviceId, name) {
    await dynamo.send(
        new UpdateCommand({
            TableName: process.env.USER_TABLE,
            Key: {
                username: username,
            },
            UpdateExpression: "SET pending = :pending",
            ExpressionAttributeValues: {
                ":pending": {
                    deviceId: deviceId,
                    name: name,
                },
            },
        })
    );
}

export async function handler(event) {
    let body;
    try {
        body = JSON.parse(event.body);
    } catch (err) {
        return {
            statusCode: 400,
            body: "Invalid request body",
        };
    }

    const name = body?.data;
    if (typeof name !== "string" || name.length === 0) {
        return {
            statusCode: 400,
            body: "Invalid request body",
        };
    }
    if (name.length > 255) {
        return {
            statusCode: 400,
            body: "Device name cannot be longer than 255 characters",
        };
    }

    const connectionId = event.requestContext.connectionId;
    const username = await getUsername(connectionId);
    if (!username) {
        return {
            statusCode: 401,
            body: "No user found for connection",
        };
    }

    const deviceId = randomBytes(9)
        .toString("base64")
        .replace(/\+/g, ":")
        .replace(/\//g, "_");
    try {
        await addDevice(username, deviceId, name);
    } catch (err) {
        console.error(err);
        return {
            statusCode: 500,
            body: "Failed to add device",
        };
    }

    return {
        statusCode: 200,
        body: JSON.stringify({ action: body.action, data: deviceId }),
    };
}
