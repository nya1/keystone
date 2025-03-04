---
title: "Authentication and Access Control"
description: "Learn how to use Keystone's built-in Authentication and Access Control systems."
---

Keystone comes with several features that work together to control access to the Admin UI and GraphQL API:

- **Session Management** – a set of APIs for starting and ending user sessions, as well as initialising the session data for each request ([docs](../apis/session))
- **The `auth` package** – an opinionated implementation of authentication features for Keystone apps ([docs](../apis/auth))
- **Access Control** – a powerful framework for restricting access to specific lists, operations, and fields ([docs](../apis/access-control))
- **Dynamic UI Config and Field Modes** – options for the Admin UI that work similarly to Access Control, and let you dyamically configure the Admin UI based on user permissions ([docs](../apis/schema#ui))

Session Management and Auth are extremely flexible in Keystone, and it's possible to replace the default implementations we provide with your own (or integrate an entirely separate auth system), but in this guide we'll focus on how all these features are designed to work together.

## Setting up Users, Auth and Session

While you can use Keystone's APIs to implement your own custom session and authentication systems, we've built one for you that probably does what you need most of the time: the `@keystone-6/auth` package. We recommend starting with that.

Keystone is designed to make as few assumptions about your schema and system design as possible, which means it doesn't come with a built-in concept of **Users**. In your app, Users are just another List that you create and specify fields for – you can set them up however you like.

### Create a list for users

To use the `auth` package, you need to nominate a list that stores your user accounts, and that lists needs at least two fields: an **identity** field (e.g username or email address, it should be unique) that users are looked up by when they sign in; and a **secret** field (i.e password) that is used to verify them.

You can add any other fields you want to your users list, including contact information, permissions, roles, and relationships to other entities in your database.

Here's an example:

```ts
const Person = list({
  fields: {
    name: text(),
    email: text({ isIndexed: 'unique' }),
    password: password(),
    isAdmin: checkbox(),
  },
});
```

{% hint kind="tip" %}
Read more about creating lists in the [schema](../apis/schema) and [fields](../apis/schema) API Docs.
{% /hint %}

### Configure authentication

With our users list in place, we can start configuring our authentication:

```ts
import { createAuth } from '@keystone-6/auth';

const { withAuth } = createAuth({
  listKey: 'Person',
  identityField: 'email',
  secretField: 'password',
});
```

The `createAuth` function returns another function called `withAuth` that will automatically extend Keystone's config to set up everything we need. Behind the scenes, the `auth` package is just using lower-level Keystone APIs to do everything, which means if you want to do something differently, you can fork our implementation of `auth` and build your own (this is true for session management as well)

{% hint kind="tip" %}
Read more about `createAuth` in the [Auth API Docs](../apis/auth).
{% /hint %}

### Configure sessions

Finally we need to tell Keystone how to track sessions. The simplest method is to use **stateless sessions**, which use an encrypted cookie to store enough information for Keystone to identify the item on each request. They're like JWTs, but without the downsides.

```ts
const session = statelessSessions({
  secret: '-- EXAMPLE COOKIE SECRET; CHANGE ME --',
});
```

Keystone also comes with a Redis session adapter, which uses a cookie to store a session ID that is looked up in a Redis database; or you can use your own session adapter (for example, if you are using OAuth sessions).

{% hint kind="tip" %}
Read more about [Session Stores in the Session API Docs](../apis/session#session-stores).
{% /hint %}

### Putting it all together

Your entire Keystone config should now look like this:

```ts
import { config, list } from '@keystone-6/core';
import { checkbox, password, text } from '@keystone-6/core/fields';
import { statelessSessions } from '@keystone-6/core/session';
import { createAuth } from '@keystone-6/auth';

const db = {
  provider: 'sqlite',
  url: process.env.DATABASE_URL || 'file:./keystone-example.db',
};

const { withAuth } = createAuth({
  listKey: 'Person',
  identityField: 'email',
  secretField: 'password',
});

const session = statelessSessions({
  secret: '-- EXAMPLE COOKIE SECRET; CHANGE ME --',
});

const lists = {
  Person: list({
    fields: {
      name: text(),
      email: text({ isIndexed: 'unique' }),
      password: password(),
      isAdmin: checkbox(),
    },
  }),
};

export default withAuth(
  config({
    db,
    lists,
    session,
  })
);
```

## Loading Session Data

At the start of every request, Keystone will initialise in-memory session data for the request. When you're using the `auth` package, a session cookie is used to identify an item in the database that represents the current user, and then a query is run to load data about that item.

The result of the query is stored in `context.session`, and available to almost every function and hook in Keystone – including access control.

In this initialisation phase, you'll want to load any data you'll need to work out what the user should be able to do (and what they should not be able to do).

If no session cookie is present, or no matching item can be found, `context.session` will be `undefined`.

### Add a sessionData query

In our example above, we probably want to know the current user's ID and the value of the `isAdmin` checkbox. The `auth` package makes this simple by providing a `sessionData` option, which should contain the fields to query when a session is found.

You configure it like this:

```ts
const { withAuth } = createAuth({
  // ...
  sessionData: 'isAdmin',
});
```

Think of this like the field selection in a GraphQL query. You can load any fields you need to have at hand when writing Access Control methods, including virtual fields and relationships.

The equivalent GraphQL query would look like this:

```graphql
query {
  person(where: { id: $session.itemId }) {
    id
    isAdmin
  }
}
```

## Adding Access Control

Now that we have information about the current user, lets put it to good use and add some security to our API with **Access Control**.

The way to think about access control is –

- With **Session Data**, you know who the user is, and what they should have access to (whether that's permissions granted by a role, or items related to them)
- For each **List** you can restrict which operations they can perform, filter the items they have access to, and control which fields they can read and update.

{% hint kind="tip" %}
In other words: **Step 1** load data about the current user; **Step 2** use that data to limit what they can do.
{% /hint %}

You define access control for each List (and field) individually; the rules you specify will always be run, even when the list is being queried or mutated through a relationship.

### Posts Example

Let's say we have a list of Blog Posts, which have a published status. We want Admin users to see all blog posts and be able to create and update them, but anonymous (public) users can only see published posts and can't write to the API. Our Post list might look like this:

```ts
const Post = list({
  fields: {
    title: text(),
    isPublished: checkbox(),
    publishDate: timestamp(),
    author: relationship({ ref: 'Person' }),
    // more content fields would go here
  },
});
```

And the Session Data we set up above would look like this:

```ts
type Session = {
  data: {
    id: string;
    isAdmin: boolean;
  }
}
```

We can now set up **operation** access control to restrict the **create**, **update** and **delete** operations to authenticated users with the `isAdmin` checkbox set:

```ts
const isAdmin = ({ session }: { session: Session }) => session?.data.isAdmin;

const Post = list({
  access: {
    operation: {
      create: isAdmin,
      update: isAdmin,
      delete: isAdmin,
    },
  },
  fields: {
    // see above
  },
});
```

We can also use **filter** access control to make sure that unauthenticated users can only see published posts:

```ts
const filterPosts = ({ session }: { session: Session }) => {
  // if the user is an Admin, they can access all the records
  if (session?.data.isAdmin) return true;
  // otherwise, filter for published posts
  return { isPublished: { equals: true } };
}

const Post = list({
  access: {
    operation: {
      // see above
    },
    filter: {
      query: filterPosts,
    }
  },
  fields: {
    // see above
  },
});
```

When there's no session, or the user is not an Admin, the `filterPosts` function returns a filter object. This is the same format as the `where` arguments you can provide to the `posts` query through the GraphQL API:

```graphql
query {
  posts(where: { isPublished: { equals: true } }) {
    title
  }
}
```

{% hint kind="tip" %}
An easy way to set up Access Control filters is to write them as queries in the GraphQL Playground, then test them to make sure they return the results you expect. When you're happy, copy and paste the `where` input into your access control function.
{% /hint %}

These filters are **combined** with any filters provided through the GraphQL API, and there's no way to circumvent them when making HTTP Requests.

You can also return a boolean value to switch on or off access to a list entirely:

- `true` allows access to all items in the list
- `false` prevents access to all items in the list

In the example above, if the user has `isAdmin` we return `true` allowing them to access all posts.

Access control is always applied when querying or mutating items in a list, regardless of how GraphQL queries are written. For example, if we also had a **Tags** list that relates to **Posts**:

```ts
const Tag = list({
  fields: {
    label: text(),
    posts: relationship({ ref: 'Post', many: true }),
  },
});
```

You can query all the posts linked to each tag, but the filters we've defined above on `Post` will still be applied.

```graphql
query {
  tags {
    posts {
      title
    }
  }
}
```

Unauthenticated users won't be able to find unpublished posts by querying the relationship field on tags, and you don't have to do anything special to make this work.

### Operations

Each specific operation that can be performed through the GraphQL API has corresponding access control you can provide. The four operations are:

- Query
- Create
- Update
- Delete

Access control is operation-specific, so if you want to prevent _any_ changes being made to items in a list, you would need to provide settings for all the mutation operations: `create`, `update` and `delete`.

#### Why it's `query` and not `read`

Because of the way GraphQL works, you can retrieve an item through both **queries** _and_ **mutations**. The `query` rules don't affect mutations, so our **list** access control is aligned to GraphQL operations.

For example, both the `person` query and `updatePerson` mutation will find a Person by their ID and return their name:

```graphql
query {
  person(where: { id: 1 }) {
    name
  }
}
mutation {
  updatePerson(where: { id: 1 }) {
    name
  }
}
```

{% hint kind="tip" %}
Note: this is different to **field** access control, where the `read` access control rule will affect a user's ability to retrieve the value for that field regardless of the query or mutation.
{% /hint %}

### Different levels of Access Control

Keystone provides three different levels of access control for lists, as well as field-level access control. Here are the available functions for lists:

```ts
type Filter = Record<string, any>; // the GraphQL Filters for the List

type Access = {
  operation: {
    query: ({ session, context, listKey, operation }) => boolean;
    create: ({ session, context, listKey, operation }) => boolean;
    update: ({ session, context, listKey, operation }) => boolean;
    delete: ({ session, context, listKey, operation }) => boolean;
  };
  filter: {
    query: ({ session, context, listKey, operation }) => Filter | boolean;
    update: ({ session, context, listKey, operation }) => Filter | boolean;
    delete: ({ session, context, listKey, operation }) => Filter | boolean;
  };
  item: {
    create: ({ session, context, listKey, operation, inputData }) => boolean;
    update: ({ session, context, listKey, operation, inputData, item }) => boolean;
    delete: ({ session, context, listKey, operation, item }) => boolean;
  };
};
```

{% hint kind="tip" %}
We'll cover field access control separately below.
{% /hint %}

You'll generally only need to use a subset of the available options:

- If you want to block an operation based on Session Data, use `operation`
- If you want to filter items based on Session Data, use `filter`
- If you need to block an operation **or** filter items based on Session Data, use `filter`
- If you need to check some logic based on the item data or input data, use `item`

#### How `filter` access control works

Filter access control is combined with `where` input from the GraphQL Query to create the full set of conditions provided to the database query. It can be used to limit which records can be queried and mutated in your system.

In addition to returning filters, you can return a boolean where:

- `true` effectively means match _all_ records (no filter is applied)
- `false` effectively means match _no_ records (the operation will be blocked)

{% hint kind="tip" %}
Returning a boolean from filter access control is functionally the same as using operation access control, so if you specify filter access control, you rarely also need to specify operation access control.
{% /hint %}

Query filters are also applied to count operations, so you can paginate items predictably without revealing the existence of items the user does not have access to.

Although Keystone doesn't implement database-level security, the design and effect of `filter` access control is similar to [Row Level Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) in Postgres, with the benefit of being expressed declaratively in TypeScript and using the same filter syntax as the GraphQL API. This makes it easier to reason about in the context of your schema, session data, and other logic in your application.

You can't specify filters for the `create` operation because you can't query records that don't exist yet.

#### How `item` access control works

When mutating items, item access control is checked against the mutation input (for `create` and `update`) and the item that has been retrieved from the database (for `update` and `delete`).

This gives you the most granular control over whether an operation is allowed to proceed, but is the least performant because:

- Keystone retrieves all matching records from the database before the access control rule can be evaluated
- For the operations `updateMany` and `deleteMany` item access control function is invoked once for each item being updated or deleted

If you need to limit access to some items in a list, filter access control is usually the best option. Item access control should only be used if you have logic that can't be expressed as a filter, or if you need to check the `inputData` provided to the mutation.

### Access Control in Hooks and Extensions

Because the current request (including Session Data) is bound to the **Keystone Context**, any queries or mutations you run inside Hooks, Virtual Fields, and GraphQL Extensions will respect access control.

For example, if we have a custom query that returns all posts written in the last week, sorted by publish date:

```ts
const extendGraphqlSchema = graphQLSchemaExtension({
  typeDefs: `
    type Query {
      recentPosts: [Post!]
    }`,
  resolvers: {
    Query: {
      recentPosts: (root, args, context) => {
        var oneWeekAgo = new Date();
        oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
        return context.db.Post.findMany({
          where: { publishDate: { gt: oneWeekAgo.toUTCString() } },
          orderBy: { publishDate: 'desc' },
        });
      },
    },
  },
});
```

The query will respect the access control rules for the `Post` list, and unauthenticated users will only see published posts.

### Circumventing Access Control

Sometimes, you need to bypass access control. For example, you may have a hook that needs to query or mutate data the user making the request doesn't have access to; or you might have blocked access to creating new User items and instead written a custom signup mutation.

When you need it, you can call `context.sudo()` to create a new context with elevated privileges that will bypass access control. Combining this with GraphQL extensions is a great way to keep your access control rules relatively simple, while carefully exposing specific functionality through your API.

For example, we probably want to block all public access to querying users in our system:

```ts
const isAdmin = ({ session }: { session: Session }) => session?.data.isAdmin;

const Person = list({
  access: {
    query: isAdmin,
  },
  fields: {
    // see above
  },
}),
```

But if we have a signup form in our app, we may want to be able to check whether an email address is in use so we can do client-side validation, without giving away any other information.

We can create a custom query for this, and use `context.sudo()` to bypass access control and find a matching user, while only returning a boolean from the query:

```ts
const extendGraphqlSchema = graphQLSchemaExtension({
  typeDefs: `
    type Query {
      isEmailInUse(email: String!): Boolean!
    }`,
  resolvers: {
    Query: {
      isEmailInUse: async (root, { email }, context) => {
        const sudoContext = context.sudo();
        const emailCount = await sudoContext.db.User.count({
          where: {
            email: { equals: email, mode: 'insensitive' },
          },
        });
        return !!emailCount;
      },
    },
  },
});
```

## Field Access Control

We've covered access control for lists now; but Keystone also lets you specify field-level access control, which is important when users should only be able to perform operations on _some of the fields_ in items that they can access.

You can provide field-level rules for:

- Read – applied when the field is selected through any GraphQL operation
- Create – applied when items are being created
- Update – applied when items are being updated

{% hint kind="tip" %}
If you want to completely block users from setting a field's value, make sure you set both the `create` and `update` rules.
{% /hint %}

For more information about the arguments provided to field rules, see the [Access Control API Docs](../apis/access-control#field-access-control)

### People Example

Building on our blog example above, let's implement the following rules for our **Person** list:

- Anyone should be able to see the names of people in the system (otherwise we wouldn't be able to display authors' names)
- Visitors are never able to see a person's email addresses
- Users are able to see their own email address
- Users can update their own name and email address
- Users can only update their own password
- Admins can update information for any user _except_ their password
- Only admins can change the `isAdmin` checkbox
- Only admins can create and delete users

The implementation of these rules would look like this:

```ts
type PersonData = {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
};

// Validate there is a user with a valid session
const isUser = ({ session }: { session: Session }) =>
  !!session?.data.id;

// Validate the current user is an Admin
const isAdmin = ({ session }: { session: Session }) =>
  session?.data.isAdmin;

// Validate the current user is updating themselves
const isPerson = ({ session, item }: { session: Session, item: PersonData }) =>
  session?.data.id === item.id;

// Validate the current user is an Admin, or updating themselves
const isAdminOrPerson = ({ session, item }: { session: Session, item: PersonData }) =>
  isAdmin({ session }) || isPerson({ session, item });

const Person = list({
  access: {
    operation: {
      create: isAdmin,
      delete: isAdmin,
    },
    item: {
      update: isAdminOrPerson,
    },
  },
  fields: {
    name: text(),
    email: text({ isIndexed: 'unique', access: {
      read: isAdminOrPerson,
    }}),
    password: password({ access: {
      // Note: password fields never reveal their value, only whether a value exists
      read: isAdminOrPerson,
      update: isPerson,
    }}),
    isAdmin: checkbox({ access: {
      read: isUser,
      update: isAdmin,
    }}),
  },
});
```

## Related resources

{% related-content %}
{% well
heading="Authentication"
href="../apis/auth" %}
Documentation for the Auth Package API
{% /well %}
{% well
heading="Access Control"
href="../apis/access-control" %}
Documentation for the Access Control API
{% /well %}
{% /related-content %}
