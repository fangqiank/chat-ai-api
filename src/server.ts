import express, {Request, Response} from "express";
import cors from "cors";
import dotenv from "dotenv";
import {StreamChat} from "stream-chat";
import {db} from "./config/database.js";
import {chats, users} from "./db/schema.js";
import {eq} from "drizzle-orm";
import OpenAI from "openai";
import {ChatCompletionMessageParam} from "openai/resources";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(
  express.urlencoded({
    extended: false,
  })
);

const chatClient = StreamChat.getInstance(
  process.env.STREAM_API_KEY!,
  process.env.STREAM_API_SECRET!
);

// const openai = new OpenAI({
//   apiKey: process.env.OPENAI_API_KEY,
// });

const openai = new OpenAI({
  baseURL: process.env.DEEPSEEK_BASE_URL,
  apiKey: process.env.DEEPSEEK_API_KEY,
});

app.post(
  "/register-user",
  async (req: Request, res: Response): Promise<any> => {
    const {name, email} = req.body;

    if (!name || !email) {
      return res.status(400).json({message: "Name and Email are required"});
    }

    try {
      const userId = email.replace(/[^a-zA-Z0-9_-]/g, "_");

      const userResponse = await chatClient.queryUsers({
        id: {
          $eq: userId,
        },
      });

      if (!userResponse.users.length) {
        await chatClient.upsertUser({
          id: userId,
          name,
          email,
          role: "user",
        });
      }

      const existingUser = await db
        .select()
        .from(users)
        .where(eq(users.userId, userId));

      if (!existingUser.length) {
        console.log("User not found in database, creating new user...");

        await db.insert(users).values({
          userId,
          name,
          email,
        });
      }

      res.status(200).json({
        userId,
        name,
        email,
      });
    } catch (error) {
      res.status(500).json({error: "Internal Server Error"});
    }
  }
);

app.post("/chat", async (req: Request, res: Response): Promise<any> => {
  const {userId, message} = req.body;

  if (!userId || !message) {
    return res.status(400).json({message: "User ID and Message are required"});
  }

  try {
    const userResponse = await chatClient.queryUsers({
      id: {
        $eq: userId,
      },
    });

    if (!userResponse.users.length) {
      return res.status(404).json({message: "User not found"});
    }

    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.userId, userId));

    if (!existingUser.length) {
      return res.status(404).json({message: "User not found in database"});
    }

    // Fetch users past messages for context
    const chatHistory = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(chats.createdAt)
      .limit(10);

    // Format chat history for Open AI
    const conversationHistory: ChatCompletionMessageParam[] =
      chatHistory.flatMap((chat) => [
        {role: "user", content: chat.message},
        {role: "assistant", content: chat.reply},
      ]);

    conversationHistory.push({role: "user", content: message});

    const chatResponse = await openai.chat.completions.create({
      model: "deepseek-chat",
      messages: conversationHistory as ChatCompletionMessageParam[],
      temperature: 0.1,
      max_tokens: 256,
    });

    const aiMessage =
      chatResponse.choices[0].message?.content ?? "No response from DeepSeek";

    await db.insert(chats).values({
      userId,
      message,
      reply: aiMessage,
    });

    const channel = chatClient.channel("messaging", `chat-${userId}`, {
      name: `AI Chat`,
      created_by_id: "ai_bot",
    });

    await channel.create();
    await channel.sendMessage({
      text: aiMessage,
      user_id: "deepseek_bot",
    });

    res.status(200).json({
      reply: aiMessage,
    });
  } catch (error) {
    res.status(500).json({error: "Internal Server Error"});
  }
});

app.post("/get-messages", async (req: Request, res: Response): Promise<any> => {
  const {userId} = req.body;

  if (!userId) {
    return res.status(400).json({message: "User ID is required"});
  }

  try {
    const history = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId));

    res.status(200).json({
      messages: history,
    });
  } catch (error) {
    console.log("Error fetching chat history", error);
    res.status(500).json({error: "Internal Server Error"});
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
